import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { eq, inArray } from "drizzle-orm";

import { agentReady, queuePolish } from "./agent";
import { db, schema } from "./db";
import { asrModel, asrThreads, env, modelPaths } from "./env";
import { openFile } from "./memobento";
import {
  bumpAttempts,
  clearSegments,
  countSegments,
  getRecordingRow,
  putSegment,
  setRecordingState,
} from "./recording-server";
import type { RecordingNoticeDTO } from "./types";

/**
 * 전사 줄 세우기 — **워커의 부모.**
 *
 * 워커(`scripts/transcribe.mjs`)는 자식 프로세스로 뜬다. 그 이유는 워커 파일
 * 첫머리에 길게 적어 두었다: 이 ASR 바인딩의 C++ 예외는 `std::terminate()` 를
 * 불러 **어떤 try/catch 로도 안 잡히고** 프로세스를 죽인다. Next 서버 안에서
 * 돌리면 긴 파일 하나가 앱 전체를 죽인다.
 *
 * 여기서 하는 일은 셋이다.
 *
 * 1. **줄 세우기.** 동시에 몇 개를 돌릴지는 `TRANSCRIBE_CONCURRENCY` 가 정하고
 *    기본은 1이다 (근거는 `lib/env.ts` 에 적어 두었다 — 요약하면 물리 4코어를
 *    워커 하나가 이미 다 쓰기 때문에, 둘을 나란히 돌리면 평균 대기가 오히려
 *    길어진다).
 * 2. **받아 적기.** 워커가 조각 하나를 끝낼 때마다 stdout 한 줄이 오고, 그것을
 *    바로 DB 에 넣는다. 55분째에 죽어도 55분치는 남는다.
 * 3. **다시 뜰 때 회수.** 컨테이너가 재시작하면 `transcribing` 인 채로 남은
 *    줄이 있다. 아래 `recoverStaleJobs()` 가 정리한다.
 */

// ─────────────────────────────────────────────────────────────
//   프로세스 하나에 줄 하나
// ─────────────────────────────────────────────────────────────

interface QueueState {
  /** 기다리는 녹음 id. 앞에서부터 꺼낸다. */
  waiting: string[];
  /** 지금 도는 것. 같은 녹음이 두 번 뜨는 것을 막는 자물쇠이기도 하다. */
  running: Map<string, ChildProcess>;
  /** 부팅 회수를 한 번만 하려고. */
  recovered: boolean;
}

/*
 * `globalThis` 에 매단다.
 *
 * 개발 모드의 Next 는 모듈을 다시 읽는다. 모듈 지역 변수에 두면 다시 읽힐
 * 때마다 빈 줄이 새로 생겨서, 이미 도는 워커를 모르는 채로 같은 녹음을 또
 * 띄운다 — 1.6GB 짜리가 둘이 된다.
 */
const g = globalThis as typeof globalThis & { __voicebentoQueue?: QueueState };
const queue: QueueState = (g.__voicebentoQueue ??= {
  waiting: [],
  running: new Map(),
  recovered: false,
});

/** 워커가 이만큼 아무 말도 없으면 멎은 것으로 본다. */
const SILENCE_LIMIT_MS = 15 * 60_000;
/** 아무리 긴 파일이라도 여기서 끊는다 (RTF 0.096 이므로 6시간이면 60시간짜리다). */
const HARD_LIMIT_MS = 6 * 60 * 60_000;

// ─────────────────────────────────────────────────────────────
//   바깥에서 부르는 것
// ─────────────────────────────────────────────────────────────

/**
 * 줄에 넣는다. 이미 돌고 있거나 기다리는 중이면 아무 일도 안 한다.
 *
 * 부르는 쪽에서 기다리지 않는다 — 올리기 요청이 전사가 끝나기를 기다리면
 * 앞의 터널이 100초에서 끊는다.
 */
export function enqueue(recordingId: string): void {
  ensureStarted();
  if (queue.running.has(recordingId)) return;
  if (queue.waiting.includes(recordingId)) return;
  queue.waiting.push(recordingId);
  setRecordingState(recordingId, { state: "queued", progress: null, error: null });
  pump();
}

/** 부팅 회수를 한 번만. 라우트가 아무 때나 불러도 싸다. */
export function ensureStarted(): void {
  if (queue.recovered) return;
  queue.recovered = true;
  try {
    recoverStaleJobs();
  } catch (e) {
    console.error("[voicebento] 회수 실패:", e);
  }
}

/** 지금 줄에 몇이 서 있나. 화면이 "앞에 N건" 을 말할 수 있게. */
export function queueDepth(): { running: number; waiting: number } {
  return { running: queue.running.size, waiting: queue.waiting.length };
}

// ─────────────────────────────────────────────────────────────
//   다시 뜰 때
// ─────────────────────────────────────────────────────────────

/**
 * 컨테이너가 다시 뜬 뒤 남아 있는 줄을 정리한다.
 *
 * ## 무엇을 되살리고 무엇을 접는가 — 그리고 왜
 *
 * - `queued` — **되살린다.** 아직 아무것도 안 했으니 잃을 것이 없다.
 * - `extracting` / `transcribing` — **되살린다. 단 두 번까지.**
 *   사람이 올린 것을 자동으로 버리지 않는다. 다만 처음부터 다시 돌린다 —
 *   중간부터 잇는 길은 없다. 정규화한 WAV 도 VAD 상태도 프로세스와 함께
 *   사라졌고, 그것을 디스크에 남겨 이어 붙이는 장치는 얻는 것에 비해 너무
 *   많은 것을 새로 만든다.
 *   **두 번까지인 이유가 중요하다.** 워커를 넘어뜨리는 파일이 하나 있으면
 *   (이 바인딩은 종료 코드 134로 죽는다) 되살리기가 무한 고리가 된다 —
 *   죽고, 컨테이너가 다시 뜨고, 되살리고, 또 죽는다. 그 사이 다른 녹음은
 *   영원히 줄 뒤에 선다. `attempts` 가 그 고리를 끊는다.
 * - `polishing` — **접는다. 다만 실패가 아니라 `done` 으로.**
 *   다듬기의 재료(조각)는 이미 DB 에 온전히 있다. 잃은 것은 에이전트가
 *   돌려줄 결과뿐이고, 그건 사람이 버튼 한 번으로 다시 얻는다. 이걸 실패로
 *   접으면 멀쩡한 전사문이 빨간 글씨를 달고 앉아 있게 된다.
 */
function recoverStaleJobs(): void {
  void cleanWorkDir();

  const stale = db
    .select()
    .from(schema.recordings)
    .where(inArray(schema.recordings.state, ["queued", "extracting", "transcribing"]))
    .all();

  for (const row of stale) {
    if (row.attempts >= 2) {
      setRecordingState(row.id, {
        state: "failed",
        progress: null,
        error:
          "전사가 끝나기 전에 앱이 두 번 다시 떴습니다. 자동으로 더 시도하지 않습니다 — " +
          "이 파일이 전사 엔진을 넘어뜨리는 것일 수 있습니다. 다시 눌러 보시고, " +
          "그래도 같으면 파일을 나눠 올려 보세요.",
      });
      continue;
    }
    if (row.state !== "queued") bumpAttempts(row.id);
    // 처음부터 다시 돌린다. 반쯤 남은 조각이 새 결과와 섞이면 안 된다.
    clearSegments(row.id);
    queue.waiting.push(row.id);
    setRecordingState(row.id, { state: "queued", progress: null, error: null });
  }

  const polishing = db
    .select()
    .from(schema.recordings)
    .where(eq(schema.recordings.state, "polishing"))
    .all();
  for (const row of polishing) {
    setRecordingState(
      row.id,
      {
        state: "done",
        polishJobId: null,
        polishStartedAt: null,
        polishError:
          "앱이 다시 뜨면서 다듬기가 끊겼습니다. 전사문은 그대로 있습니다 — 다시 눌러 주세요.",
      },
      ["polishing"],
    );
  }

  if (stale.length || polishing.length) {
    console.log(
      `[voicebento] 회수: 전사 ${stale.length}건 다시 줄 세움, 다듬기 ${polishing.length}건 접음`,
    );
  }
  pump();
}

/** 작업 폴더를 비운다. 살아남은 임시 파일은 하나도 쓸모가 없다. */
async function cleanWorkDir(): Promise<void> {
  const dir = resolve(env.WORK_DIR);
  try {
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir)) {
      await rm(join(dir, name), { force: true, recursive: true }).catch(() => undefined);
    }
  } catch {
    /* 작업 폴더 청소가 앱을 막지 않는다 */
  }
}

// ─────────────────────────────────────────────────────────────
//   줄 밀기
// ─────────────────────────────────────────────────────────────

function pump(): void {
  while (queue.running.size < env.TRANSCRIBE_CONCURRENCY && queue.waiting.length > 0) {
    const id = queue.waiting.shift()!;
    if (queue.running.has(id)) continue;
    // 자물쇠를 먼저 건다. `run()` 안에서 처음 await 를 만나기 전에 같은 id 가
    // 또 들어오면 워커가 둘이 된다.
    queue.running.set(id, null as unknown as ChildProcess);
    void run(id).finally(() => {
      queue.running.delete(id);
      pump();
    });
  }
}

// ─────────────────────────────────────────────────────────────
//   한 건 돌리기
// ─────────────────────────────────────────────────────────────

interface RunStats {
  duration: number | null;
  segments: number;
  empty: number;
  /** 나온 글자 수. 밀도로 "모르는 말" 을 짚는 데 쓴다. */
  chars: number;
  /** 말이 있던 시간의 합 (VAD 조각들의 길이). 전체 길이보다 짧다. */
  speech: number;
}

async function run(recordingId: string): Promise<void> {
  const row = getRecordingRow(recordingId);
  if (!row) return;

  if (!row.fileId) {
    setRecordingState(recordingId, {
      state: "failed",
      error: "올린 파일이 없습니다. 파일이 MemoBento 에 올라가지 않은 것 같습니다.",
    });
    return;
  }

  const workDir = resolve(env.WORK_DIR);
  const ext = safeExt(row.sourceName);
  const srcPath = join(workDir, `${recordingId}.src${ext}`);
  const wavPath = join(workDir, `${recordingId}.16k.wav`);

  /*
   * 여기서 `attempts` 를 올리지 않는다. **일부러다.**
   *
   * 그 값은 "몇 번 돌렸나" 가 아니라 "다시 뜨는 고리를 몇 번 겪었나" 를 센다
   * (`recoverStaleJobs`). 여기서도 올리면 평범한 한 번의 전사가 이미 1이 되고,
   * 그러면 되살리기가 한 번밖에 못 돈다 — 문서에 적힌 "두 번" 과 어긋난다.
   * 올리는 자리는 회수 한 곳뿐이고, 사람이 다시 누르면 0으로 돌아간다.
   */
  setRecordingState(recordingId, { state: "extracting", progress: null, error: null }, [
    "queued",
    "failed",
    "done",
  ]);

  try {
    await mkdir(workDir, { recursive: true });

    /*
     * 원본을 MemoBento 에서 통째로 받아 온다.
     *
     * ffmpeg 에 HTTP 주소를 그대로 물리는 길도 있지만 쓰지 않는다. 정적
     * 빌드의 프로토콜 지원은 판본마다 다르고, 무엇보다 mp4 는 moov 가 끝에
     * 있으면 **되감기가 필요하다** — 파이프로는 안 된다. 디스크에 한 번
     * 내려놓는 비용(수백 MB 쓰기)이 몇 분짜리 전사에 얹히는 것은 무시할 만하다.
     */
    await downloadSource(row.fileId, srcPath);

    const stats = await runWorker(recordingId, srcPath, wavPath);

    // 다 끝났다. 여기서부터는 전사문이 온전히 DB 에 있다.
    const notice = judgeNotice(stats);
    setRecordingState(recordingId, {
      state: "done",
      progress: null,
      error: null,
      duration: stats.duration,
      notice: notice ? JSON.stringify(notice) : null,
    });

    await maybeAutoPolish(recordingId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setRecordingState(recordingId, {
      state: "failed",
      progress: null,
      error: message.slice(0, 1000),
    });
    console.error(`[voicebento] 전사 실패 (${recordingId}):`, message);
  } finally {
    // 임시 파일은 성공하든 실패하든 지운다. 볼륨에 수백 MB 를 남기지 않는다.
    await rm(srcPath, { force: true }).catch(() => undefined);
    await rm(wavPath, { force: true }).catch(() => undefined);
  }
}

/** 확장자만 안전하게 뽑는다. ffmpeg 이 형식을 짐작하는 데 쓴다. */
function safeExt(name: string): string {
  const raw = extname(name || "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : "";
}

async function downloadSource(fileId: string, dest: string): Promise<void> {
  const res = await openFile(fileId, null);
  if (!res.ok || !res.body) {
    throw new Error(
      `MemoBento 에서 파일을 받지 못했습니다 (${res.status}). ` +
        `메모함에서 지워졌을 수 있습니다.`,
    );
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/**
 * 워커를 띄우고 그 말을 받아 적는다.
 *
 * stdout 은 **줄 단위 JSON** 이다. 조각이 온 즉시 DB 에 넣는다 — 모아 두었다가
 * 끝에 한 번에 쓰면 죽는 순간 전부 사라진다.
 */
function runWorker(
  recordingId: string,
  srcPath: string,
  wavPath: string,
): Promise<RunStats> {
  return new Promise((resolve_, reject) => {
    const script = join(process.cwd(), "scripts", "transcribe.mjs");
    const child = spawn(
      process.execPath,
      [
        script,
        "--input", srcPath,
        "--wav", wavPath,
        "--model-dir", resolve(modelPaths.dir),
        /*
         * VAD 자리를 **따로 넘긴다.** 모델 폴더 안에 있다고 짐작하면 안 된다 —
         * 스택 배포에서는 `/models/silero_vad.onnx` 로 모델 폴더보다 한 칸
         * 위에 있다 (`lib/env.ts` 의 `modelPaths`).
         */
        "--vad", resolve(modelPaths.vad),
        "--threads", String(asrThreads),
        "--ffmpeg", env.FFMPEG_PATH,
        /*
         * 모델의 성질을 **부모가 골라서 넘긴다.**
         *
         * 워커가 제 손으로 서술자 표를 다시 읽게 하지 않는다. 환경변수가
         * 어긋난 날(부모는 새 모델, 워커는 기본값) 둘이 다른 모델로 도는데
         * 그 어긋남은 아무 데도 안 보인다 — 나오는 것은 그냥 이상한 전사문
         * 이다. 부모가 고르고 워커는 따르면 그런 갈림길이 없다.
         *
         * argv 는 호스트 `ps` 에서 그대로 보인다. 여기 실리는 것은 전부
         * 공개해도 되는 사실이고 (파일 이름·표본율·VAD 값), 사람이 한 말이나
         * 열쇠는 한 글자도 없다.
         */
        "--spec", JSON.stringify(asrModel.runtime),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // 워커는 이 앱의 환경변수를 볼 이유가 없다. 인자로 다 넘긴다.
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
      },
    );
    queue.running.set(recordingId, child);

    const stats: RunStats = { duration: null, segments: 0, empty: 0, chars: 0, speech: 0 };
    let workerError: string | null = null;
    let stderrTail = "";
    let settled = false;

    // ── 멎었는지 지켜본다 ──
    const startedAt = Date.now();
    let lastBeat = Date.now();
    const watchdog = setInterval(() => {
      const silent = Date.now() - lastBeat;
      const total = Date.now() - startedAt;
      if (silent > SILENCE_LIMIT_MS) {
        workerError = `전사 엔진이 ${Math.round(silent / 60000)}분 동안 아무 말이 없어 멈췄습니다.`;
        child.kill("SIGKILL");
      } else if (total > HARD_LIMIT_MS) {
        workerError = "전사가 너무 오래 걸려 멈췄습니다.";
        child.kill("SIGKILL");
      }
    }, 30_000);

    // ── stdout: 줄 단위 JSON ──
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastBeat = Date.now();
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handleLine(recordingId, JSON.parse(line), stats, (m) => {
            workerError = m;
          });
        } catch {
          // 워커가 stdout 에 JSON 아닌 것을 흘렸다. 진단에 쓸 수 있게 남긴다.
          console.warn(`[voicebento] 워커가 이상한 줄을 보냈습니다: ${line.slice(0, 200)}`);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      lastBeat = Date.now();
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      reject(new Error(`전사 워커를 띄우지 못했습니다: ${e.message}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);

      if (workerError) return reject(new Error(workerError));
      if (code === 0) return resolve_(stats);

      /*
       * 134 는 SIGABRT 다 — **이 바인딩이 죽는 방식**이다.
       *
       * C++ 예외가 N-API 를 넘으며 `std::terminate()` 를 부른다. 워커 안에서는
       * 잡을 수 없으므로 여기서 알아본다. 사람에게 "알 수 없는 오류" 대신
       * 무슨 일이 일어난 것인지 말해 준다 — 그리고 그때까지 받아 적은 조각은
       * 이미 DB 에 남아 있다.
       */
      const abort = code === 134 || signal === "SIGABRT";
      const tail = stderrTail.trim().split("\n").slice(-6).join("\n").slice(0, 600);
      reject(
        new Error(
          abort
            ? `전사 엔진이 도중에 죽었습니다 (코드 134). 조각 하나가 모델을 넘어뜨린 것으로 보입니다. ` +
              `${stats.segments}개까지는 받아 적었고 그대로 남아 있습니다.` +
              (tail ? `\n${tail}` : "")
            : `전사 워커가 ${signal ?? code} 로 끝났습니다.` + (tail ? `\n${tail}` : ""),
        ),
      );
    });
  });
}

type LineHandler = (m: string) => void;

function handleLine(
  recordingId: string,
  msg: unknown,
  stats: RunStats,
  setError: LineHandler,
): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;

  switch (m.type) {
    case "stage": {
      if (m.stage === "transcribing") {
        setRecordingState(recordingId, { state: "transcribing", progress: 0 }, [
          "extracting",
          "queued",
        ]);
      }
      return;
    }

    case "meta": {
      const duration = typeof m.duration === "number" ? m.duration : null;
      stats.duration = duration;
      setRecordingState(recordingId, { duration });
      return;
    }

    case "segment": {
      const idx = num(m.idx);
      const start = num(m.start);
      const end = num(m.end);
      if (idx === null || start === null || end === null) return;
      putSegment({
        recordingId,
        idx,
        start,
        end,
        raw: typeof m.text === "string" ? m.text : "",
        words: Array.isArray(m.words)
          ? (m.words as unknown[]).flatMap((w) => {
              if (!w || typeof w !== "object") return [];
              const word = (w as { w?: unknown }).w;
              const t = (w as { t?: unknown }).t;
              if (typeof word !== "string" || typeof t !== "number") return [];
              return [{ w: word, t }];
            })
          : [],
      });
      return;
    }

    case "progress": {
      const processed = num(m.processed);
      if (processed === null) return;
      /*
       * 진행률은 **처리한 조각 시각 / 전체 길이**다.
       *
       * 1.0 에 딱 떨어지지 않는다 — 말이 없는 구간은 VAD 가 건너뛰므로
       * 마지막 조각이 끝나도 전체 길이보다 앞이다. 그래서 끝났을 때는
       * 진행률을 지우고 상태로만 말한다 (`toRecordingDTO`).
       */
      const total = stats.duration;
      if (!total || total <= 0) return;
      setRecordingState(
        recordingId,
        { progress: Math.max(0, Math.min(1, processed / total)) },
        ["transcribing"],
      );
      return;
    }

    case "done": {
      stats.segments = num(m.segments) ?? 0;
      stats.empty = num(m.empty) ?? 0;
      stats.chars = num(m.chars) ?? 0;
      stats.speech = num(m.speech) ?? 0;
      return;
    }

    case "error": {
      setError(typeof m.message === "string" ? m.message : "전사에 실패했습니다");
      return;
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─────────────────────────────────────────────────────────────
//   한국어 신호
// ─────────────────────────────────────────────────────────────

/**
 * 결과를 보고 **한국어였을 것 같다**고 짚는다.
 *
 * 이 모델(`parakeet-tdt-0.6b-v3`)의 어휘 8,193개에는 한글이 하나도 없다.
 * 한국어를 넣으면 오류가 나지 않는다 — **빈 글이나 엉뚱한 로마자**가 나온다.
 * 그래서 서버가 이 사실을 알아챌 수 있는 자리는 여기, 결과를 손에 쥔 순간뿐이다.
 *
 * 판정은 두 가지다.
 *   - 말한 시간은 있는데 조각이 거의 다 비었다.
 *   - **글자 밀도가 터무니없이 낮다.**
 *
 * 두 번째가 특히 중요하다. 빈 조각만 세는 것으로는 모자란다 — 이 모델은
 * 모르는 말을 들으면 빈 글이 아니라 `"Mm-hmm."` 같은 짧은 로마자를 내놓는
 * 일이 잦다 (직접 확인했다: 사람 목소리가 아닌 소리 7.7초에 14자). 그건
 * "비어 있다" 로 안 잡힌다. 실제 영어는 같은 잣대로 초당 20자쯤 나온다
 * (측정: 3.77초에 78자). 그래서 문턱을 5자/초로 둔다 — 사이가 네 배라
 * 웬만한 흔들림으로는 서로 넘어오지 않는다.
 *
 * 틀릴 수 있는 판정이라 **막지 않고 말만 한다.** 전사문은 그대로 남고,
 * 화면이 이 문장을 한 줄 띄운다.
 */

/** 이보다 말한 시간이 짧으면 판정하지 않는다. 짧은 소리는 표본이 못 된다. */
const MIN_SPEECH_TO_JUDGE = 20;

/**
 * "못 알아들은 것 같다" 는 문장. **서술자에서 만든다.**
 *
 * 예전에는 여기에 "parakeet-tdt-0.6b-v3 은 한국어를 못 합니다" 가 박혀
 * 있었다. 한국어를 하는 모델을 붙이는 날 이 문장이 옛말로 남고, 그러면
 * 멀쩡한 한국어 녹음에 "한국어를 못 합니다" 가 뜬다 — 사람은 파일이 잘못된
 * 줄 알고 같은 것을 다시 올린다. 원래 이 안내가 막으려던 바로 그 일이다.
 */
function unheardText(): string {
  const speaksKorean = asrModel.languages.includes("ko");
  const head =
    "소리는 들어 있는데 알아들은 글자가 거의 없습니다. " +
    `이 앱의 전사 모델(${asrModel.name})은 ${asrModel.languagesLabel}을 알아듣습니다`;
  return speaksKorean
    ? `${head}. 그 목록에 없는 말이었다면 이것이 이유입니다. 파일이 잘못된 것이 아닙니다.`
    : `${head} — **한국어는 목록에 없습니다.** 한국어를 넣으면 오류 대신 빈 글이나 ` +
        "엉뚱한 로마자가 나옵니다. 한국어 녹음이라면 이것이 이유입니다. " +
        "파일이 잘못된 것이 아닙니다.";
}

function judgeNotice(stats: RunStats): RecordingNoticeDTO | null {
  /*
   * 문턱도 모델의 성질이다.
   *
   * parakeet 은 영어를 초당 20자쯤 내놓아서 5가 넉넉한 문턱이지만, 한국어를
   * 하는 모델에 같은 값을 쓰면 멀쩡한 한국어 전사(초당 5~7자)가 통째로
   * "못 알아들었다" 로 잡힌다. 그래서 서술자에서 가져온다.
   */
  const minCharsPerSecond = asrModel.minCharsPerSecond;
  const unheard = unheardText();

  if (stats.duration !== null && stats.duration > 5 && stats.segments === 0) {
    return {
      kind: "mostly-empty",
      text:
        "말을 하나도 찾지 못했습니다. 소리가 너무 작거나, 말이 아닌 소리(음악·잡음)이거나, " +
        "이 모델이 모르는 말일 수 있습니다. " +
        unheard,
    };
  }

  if (stats.speech < MIN_SPEECH_TO_JUDGE || stats.segments === 0) return null;

  const emptyRatio = stats.empty / stats.segments;
  const density = stats.chars / stats.speech;
  if (emptyRatio > 0.4 || density < minCharsPerSecond) {
    /*
     * 갈래 이름은 `maybe-korean` 그대로 둔다. 뜻은 이제 "이 모델이 모르는
     * 말인 것 같다" 로 넓어졌지만, 이름을 바꾸면 화면이 아는 두 갈래
     * (`maybe-korean`·`mostly-empty`) 중 어느 쪽도 아닌 값이 흘러가고 그때
     * 안내가 통째로 안 뜬다 — 이 앱에서 그것이 제일 나쁜 결과다.
     * 문장은 위에서 서술자로 만들므로 모델을 갈아도 옛말이 남지 않는다.
     */
    return { kind: "maybe-korean", text: unheard };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//   전사 다음은 다듬기
// ─────────────────────────────────────────────────────────────

/**
 * 전사가 끝나면 곧바로 다듬기까지 간다 (설정에서 끌 수 있다).
 *
 * 사람이 원한 것은 "올리면 전사문이 나온다" 이지 "올리고 나서 버튼을 한 번 더
 * 누른다" 가 아니다. 다만 여기서 실패해도 **전사는 성공한 것이다** — 상태를
 * 되돌리지 않고 이유만 남긴다.
 */
async function maybeAutoPolish(recordingId: string): Promise<void> {
  if (!agentReady().ready) return;
  if (countSegments(recordingId) === 0) return;

  const cfg = db.select().from(schema.appConfig).where(eq(schema.appConfig.id, 1)).get();
  // 설정 행이 아직 없으면 기본값(켬)이다.
  if (cfg && cfg.autoPolish !== 1) return;

  /*
   * **여기가 같은 세션의 다듬기가 겹치는 주된 자리다.**
   *
   * 회의 녹음 셋을 한 세션에 나란히 올리면 전사가 끝나는 대로 각자 여기까지
   * 와서 셋이 동시에 다듬기를 시작한다. 사람이 버튼을 연달아 누르는 것과
   * 달리 이건 저절로 일어나므로 막을 사람이 없다. `queuePolish` 가 세션마다
   * 줄을 세운다 (`agent.ts`).
   *
   * 상태를 여기서 옮기지 않는다 — 줄에 서는 것과 시작하는 것이 다른 때라,
   * 그 두 자리를 아는 쪽이 상태도 옮겨야 한다.
   */
  try {
    await queuePolish(recordingId, null);
  } catch (e) {
    setRecordingState(recordingId, {
      polishError: e instanceof Error ? e.message : String(e),
    });
  }
}
