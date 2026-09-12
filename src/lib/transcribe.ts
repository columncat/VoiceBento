import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { eq, inArray } from "drizzle-orm";

import { agentReady, queuePolish } from "./agent";
import { db, schema } from "./db";
import {
  ROSTER_MISSING,
  canDiarize,
  clusterCountFor,
  estimateDiarSeconds,
} from "./diar-models";
import { assignSpeakers, silhouetteMedian, type DiarTurn, type SilTurn } from "./diarize-assign";
import {
  asrModel,
  asrThreads,
  diarModel,
  diarPaths,
  diarThreads,
  env,
  modelPaths,
} from "./env";
import { openFile } from "./memobento";
import {
  bumpAttempts,
  clearSegments,
  commitDiarization,
  countSegments,
  getRecordingRow,
  getRoster,
  listSegmentsForAssign,
  putSegment,
  reattachStoredDiarization,
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
 * ## 한 건이 지나는 길 — **세 도막**
 *
 * ```
 * ffmpeg 정규화 ─▶ [A] transcribe.mjs ── 조각마다 DB 에 앉는다 ── 여기서 이미 온전하다
 *                       ▼
 *                 [B] diarize.mjs   ← 별도 자식 프로세스, [A] 가 끝난 뒤
 *                       ▼
 *                 [C] 낱말에 붙이기 (순수 JS, sherpa 를 안 부른다)
 * ```
 *
 * **[B] 의 실패는 `recordings.state` 를 건드리지 않는다.** 전사문이 화자
 * 분리보다 먼저다 — 분리가 어떻게 실패하든 전사문은 온전해야 하고 `state` 는
 * `done` 이어야 한다. 실패는 `speakerState`·`speakerError` 에만 앉는다.
 *
 * [B] 를 [A] 와 나란히 돌리지 않는다. 둘 다 물리 4코어를 다 쓰고 메모리도
 * 각자 GB 단위다 (분리는 11.9MB/분 + 281MB, 실측 봉우리). 나란히 돌리면
 * 둘 다 느려지고 한 건이 끝나는 시각은 오히려 늦어진다.
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
  /**
   * 이 id 는 **전사를 다시 하지 않고 화자만 나눈다** (`enqueueDiarize`).
   *
   * 줄을 따로 파지 않고 같은 줄에 표시만 얹는다. 두 줄로 나누면 전사 워커와
   * 분리 워커가 나란히 돌 수 있게 되는데, 둘 다 물리 4코어를 다 쓰고 메모리도
   * 각자 GB 단위다 (전사 1.6GB · 분리는 11.9MB/분 + 281MB). 한 줄에 두면
   * `TRANSCRIBE_CONCURRENCY` 하나가 둘 다를 막아 준다.
   *
   * `Set` 이라 개발 모드에서 모듈이 다시 읽혀 옛 `queue` 객체가 남아 있어도
   * (`??=` 가 그것을 그대로 쓴다) 이 칸만 새로 생긴다 — 아래 `??=` 참조.
   */
  diarOnly: Set<string>;
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
  diarOnly: new Set(),
  running: new Map(),
  recovered: false,
});
/*
 * 옛 판의 `queue` 객체가 개발 모드에 남아 있으면 이 칸이 없다. 없는 채로
 * `.add()` 를 부르면 거기서 터지고, 터지는 자리는 사람이 단추를 누른
 * 순간이다 — 새 칸은 늘 있는 것으로 만들어 둔다.
 */
queue.diarOnly ??= new Set();

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
  /*
   * 화자 분리 **상태**도 함께 되돌린다. 여기서 안 지우면 새 전사문 옆에 지난 판의
   * 실패 이유가 그대로 앉는다. 분리 행(구간과 목소리 이름)은 `clearSegments` 가
   * 남겨 두고, 이번 판이 다시 나누거나 다시 붙인다 (`reattachIfNotSplit`).
   */
  setRecordingState(recordingId, {
    state: "queued",
    progress: null,
    error: null,
    speakerState: "none",
    speakerError: null,
  });
  pump();
}

/**
 * **화자만 다시 나눈다.** 전사문은 손대지 않는다.
 *
 * 전사가 끝난 뒤에 누르는 길이다. 세 갈래에서 쓰인다:
 *   1. 옛 녹음 — 화자 분리가 생기기 전에 올린 것. `agent-guess` 이름이 붙어
 *      있거나 아무것도 없다.
 *   2. 목록을 고쳐 다시 — 사람이 이름을 더 적었으니 `k` 가 달라진다.
 *   3. 끊긴 것 — 앱이 다시 뜨며 접힌 판 (`recoverStaleJobs` 가 그 문구에서
 *      이미 "다시 나누려면 눌러 주세요" 라고 약속한다).
 *
 * ## WAV 를 다시 만든다
 *
 * 전사 때 쓴 16kHz WAV 는 `run()` 의 `finally` 에서 지워진다 — 볼륨에 수백
 * MB 를 남기지 않으려는 것이고 그 판단은 옳다. 그래서 여기서는 원본을
 * MemoBento 에서 다시 받아 ffmpeg 으로 한 번 더 뽑는다. 60분짜리면 몇십 초
 * 이고, 분리 자체가 몇 분이라 이 비용은 묻힌다.
 *
 * **기다리지 않는다.** 부르는 쪽(라우트)은 202 만 돌려주고 화면은 상태를
 * 따라간다.
 */
export function enqueueDiarize(recordingId: string): void {
  ensureStarted();
  if (queue.running.has(recordingId)) return;
  if (queue.waiting.includes(recordingId)) return;

  queue.diarOnly.add(recordingId);
  queue.waiting.push(recordingId);
  /*
   * **`state` 를 `done` 일 때만 옮긴다.** 다듬기가 도는 중(`polishing`)이면
   * 그 표시를 빼앗지 않는다 — 둘은 서로 다른 일이고, 여기서 덮으면 다듬기가
   * 끝났을 때 `advancePolish` 가 되돌릴 자리를 잃는다.
   *
   * 상태를 옮기는 것 자체의 값은 전사 때와 같다: 화면이 `isBusy` 를 보고
   * 다시 물어보기 시작하고, 단계 이름과 남은 시간이 뜬다.
   */
  setRecordingState(recordingId, { state: "diarizing", progress: null, error: null }, ["done"]);
  setRecordingState(recordingId, { speakerState: "running", speakerError: null });
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
 * - `diarizing` — **접는다. `done` 으로, 그리고 다시 안 돌린다.**
 *   `polishing` 과 같은 까닭이고 한 가지가 더 있다. 되살리려면 정규화한
 *   WAV 가 있어야 하는데 작업 폴더는 뜰 때마다 비운다(`cleanWorkDir`) —
 *   되살리기는 곧 **원본을 다시 받아 ffmpeg 부터 다시 도는 것**이고, 그건
 *   전사까지 통째로 다시 하는 일이다. 잃는 것이 화자 표시뿐인데 그 값을
 *   치를 이유가 없다. 사람이 단추 하나로 다시 얻는다.
 *   **여기서 `clearSegments` 를 부르면 안 된다** — 전사문이 그 안에 있다.
 */
function recoverStaleJobs(): void {
  void cleanWorkDir();

  /*
   * `diarizing` 은 이 목록에 **없다.** 넣으면 아래에서 `clearSegments` 가
   * 돌아 멀쩡한 전사문이 통째로 지워진다 — 전사가 이미 끝난 상태이기 때문이다.
   */
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
    setRecordingState(row.id, {
      state: "queued",
      progress: null,
      error: null,
      speakerState: "none",
      speakerError: null,
    });
  }

  /*
   * 화자 분리가 도는 중이던 것 — **접고 다시 안 돌린다.**
   *
   * `state` 가 `diarizing` 이 아니어도 `speakerState` 가 `running` 으로 남아
   * 있을 수 있다(정확히는 그 사이 어느 순간에 죽은 경우). 둘을 따로 본다.
   */
  const diarizing = db
    .select()
    .from(schema.recordings)
    .where(
      inArray(schema.recordings.speakerState, ["running"]),
    )
    .all();
  for (const row of diarizing) {
    setRecordingState(row.id, {
      speakerState: "failed",
      speakerError:
        "앱이 다시 뜨면서 화자 구분이 끊겼습니다. 전사문은 그대로 있습니다 — " +
        "화자만 다시 나누려면 눌러 주세요.",
    });
    // 전사는 끝난 상태다. 상태를 `done` 으로 되돌려 준다.
    setRecordingState(row.id, { state: "done", progress: null, error: null }, ["diarizing"]);
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

  if (stale.length || polishing.length || diarizing.length) {
    console.log(
      `[voicebento] 회수: 전사 ${stale.length}건 다시 줄 세움, ` +
        `화자 구분 ${diarizing.length}건 접음, 다듬기 ${polishing.length}건 접음`,
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
    /*
     * 표시를 **꺼내면서 지운다.** 남겨 두면 다음에 같은 녹음을 평범하게 다시
     * 전사할 때 그 표시가 그대로 걸려 전사를 건너뛴다.
     */
    const diarOnly = queue.diarOnly.delete(id);
    // 자물쇠를 먼저 건다. `run()` 안에서 처음 await 를 만나기 전에 같은 id 가
    // 또 들어오면 워커가 둘이 된다.
    queue.running.set(id, null as unknown as ChildProcess);
    void (diarOnly ? runDiarizeOnly(id) : run(id)).finally(() => {
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

    /*
     * 원본은 여기서 지운다. **WAV 는 안 지운다 — [B] 가 그것으로 돈다.**
     *
     * 원본은 영상이면 수백 MB 인데 WAV 가 생긴 뒤로는 아무도 안 본다.
     * 화자 분리가 몇 분 도는 동안 볼륨에 붙들고 있을 이유가 없다.
     */
    await rm(srcPath, { force: true }).catch(() => undefined);

    // 여기서부터 전사문은 온전히 DB 에 있다. 아래 무엇이 실패해도 이건 그대로다.
    const notice = judgeNotice(stats);
    setRecordingState(recordingId, {
      progress: null,
      error: null,
      duration: stats.duration,
      notice: notice ? JSON.stringify(notice) : null,
    });

    /*
     * [B]+[C] 화자 분리. **절대 던지지 않는다** — 던지면 아래 catch 가
     * `state` 를 `failed` 로 옮겨, 멀쩡한 전사문이 실패한 것처럼 앉는다.
     */
    await diarize(recordingId, wavPath, stats.duration);
    // 다시 전사한 녹음인데 이번에 새로 못 나눴으면, 남겨 둔 구간으로 새 조각에 붙인다. 던지지 않는다.
    reattachIfNotSplit(recordingId);

    setRecordingState(recordingId, { state: "done", progress: null, error: null });

    await maybeAutoPolish(recordingId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setRecordingState(recordingId, {
      state: "failed",
      progress: null,
      /*
       * 화면에 뜨는 문장이라 **경로를 지운다** (`scrubPaths`). 여기 오는 것에는 워커를 못 띄운
       * `spawn … ENOENT`(실행 파일 경로)나 파일 시스템 오류(작업 폴더의 녹음 id 가 든 경로)가
       * 섞인다. 원문은 아래 로그에 남긴다.
       */
      error: scrubPaths(message).slice(0, 1000),
    });
    console.error(`[voicebento] 전사 실패 (${recordingId}):`, message);
  } finally {
    // 임시 파일은 성공하든 실패하든 지운다. 볼륨에 수백 MB 를 남기지 않는다.
    await rm(srcPath, { force: true }).catch(() => undefined);
    await rm(wavPath, { force: true }).catch(() => undefined);
  }
}

/**
 * **화자만 나누는 한 판.** 전사는 안 한다.
 *
 * `run()` 과 나란히 놓고 보면 차이가 분명하다 — 여기에는 `clearSegments` 도
 * `putSegment` 도 없다. 조각은 이미 DB 에 온전히 있고 우리는 거기에 화자만
 * 얹는다. 그래서 **이 함수가 어떻게 실패하든 전사문은 한 글자도 안 바뀐다.**
 *
 * `state` 를 `failed` 로 옮기지 않는 것도 같은 까닭이다. 실패는
 * `speakerState`·`speakerError` 에만 앉고 `state` 는 `done` 으로 돌아간다.
 */
async function runDiarizeOnly(recordingId: string): Promise<void> {
  const row = getRecordingRow(recordingId);
  if (!row) return;

  const workDir = resolve(env.WORK_DIR);
  const ext = safeExt(row.sourceName);
  const srcPath = join(workDir, `${recordingId}.diar.src${ext}`);
  const wavPath = join(workDir, `${recordingId}.diar.16k.wav`);

  try {
    if (getRoster(recordingId).length === 0) {
      /*
       * 목록이 없다. 라우트가 한 명 이상을 받으므로 여기 올 일은 드물지만,
       * 온다면 **원본을 받고 ffmpeg 을 돌리기 전에** 멈춘다 — 어차피 `diarize()`
       * 가 같은 이유로 건너뛸 것을 몇십 초 들여 알 까닭이 없다.
       */
      setRecordingState(recordingId, { speakerState: "skipped", speakerError: ROSTER_MISSING });
      return;
    }
    if (!row.fileId) {
      /*
       * 붙어 있는 파일이 없다. 이건 실패가 아니라 **할 수 없는 일**이다 —
       * 소리가 없는데 소리로 가를 수는 없다. 그래서 `skipped` 이고, 문장도
       * 고장이 아니라 사실의 보고로 적는다.
       */
      setRecordingState(recordingId, {
        speakerState: "skipped",
        speakerError:
          "이 녹음에는 붙어 있는 소리 파일이 없어 화자를 나눌 수 없습니다. 전사문은 그대로입니다.",
      });
      return;
    }

    await mkdir(workDir, { recursive: true });
    await downloadSource(row.fileId, srcPath);
    await extractWav(srcPath, wavPath);
    /*
     * 원본은 WAV 가 생기는 즉시 버린다. 영상이면 수백 MB 인데 분리가 도는
     * 몇 분 동안 볼륨에 붙들고 있을 이유가 없다 — `run()` 과 같은 규율이다.
     */
    await rm(srcPath, { force: true }).catch(() => undefined);

    await diarize(recordingId, wavPath, row.duration);
  } catch (e) {
    /*
     * 여기까지 오는 것은 **소리를 구하는 데 실패한 것**뿐이다 (내려받기 ·
     * ffmpeg). 분리 자체는 `diarize()` 가 제 안에서 다 삼킨다.
     */
    const message = e instanceof Error ? e.message : String(e);
    setRecordingState(recordingId, {
      speakerState: "failed",
      // 내려받기·ffmpeg 문장에도 작업 폴더 경로가 실릴 수 있다. 화면으로 가는 쪽만 지운다.
      speakerError: `화자를 나눌 소리를 준비하지 못했습니다: ${scrubPaths(message)}`.slice(0, 1000),
    });
    console.error(`[voicebento] 화자 다시 나누기 실패 (${recordingId}):`, message);
  } finally {
    await rm(srcPath, { force: true }).catch(() => undefined);
    await rm(wavPath, { force: true }).catch(() => undefined);
    /*
     * 어느 길로 왔든 `state` 는 `done` 으로 돌려놓는다. **`diarizing` 일
     * 때만** 옮긴다 — 그 사이 사람이 다시 전사를 눌렀으면 `queued` 인데,
     * 그것을 `done` 으로 덮으면 돌고 있는 전사가 끝난 것처럼 보인다.
     */
    setRecordingState(recordingId, { state: "done", progress: null, error: null }, ["diarizing"]);
  }
}

/**
 * 원본에서 16kHz 모노 WAV 를 뽑는다. **인자는 `transcribe.mjs` 와 같아야 한다.**
 *
 * 같은 소리를 두 번 다르게 정규화하면 화자 분리가 처음 판과 다음 판에서 다른
 * 답을 내는데, 그 차이는 아무 데도 안 보인다. 그래서 값을 여기서 새로 고르지
 * 않고 워커의 `extractAudio()` 를 그대로 옮겨 적는다
 * (`-vn -ac 1 -ar 16000 -acodec pcm_s16le`).
 *
 * 워커를 대신 부르지 않는 이유: `transcribe.mjs` 는 뽑은 WAV 로 **전사까지**
 * 간다. 화자만 나누려고 60분짜리를 6분 더 옮겨 적을 수는 없다.
 */
function extractWav(srcPath: string, wavPath: string): Promise<void> {
  return new Promise((done, reject) => {
    const ff = spawn(
      env.FFMPEG_PATH,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", srcPath,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-acodec", "pcm_s16le",
        "-f", "wav",
        "-y", wavPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ff.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    ff.on("error", (e: NodeJS.ErrnoException) => {
      reject(
        new Error(
          e.code === "ENOENT"
            ? `ffmpeg 을 찾지 못했습니다 (${env.FFMPEG_PATH}).`
            : `ffmpeg 을 띄우지 못했습니다: ${e.message}`,
        ),
      );
    });
    ff.on("close", (code) => {
      if (code === 0) return done();
      // ffmpeg 은 오류에 입력 파일의 전체 경로를 적는다. 이 문장은 화면까지 가므로 경로를 지운다.
      reject(new Error(`ffmpeg 이 ${code} 로 끝났습니다: ${scrubPaths(stderr.trim().slice(-400))}`));
    });
  });
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

      if (workerError) {
        /*
         * 워커가 스스로 낸 문장도 **화면으로 간다** (`recordings.error`). 거기에 모델
         * 파일이나 작업 폴더의 경로가 실려 올 수 있어 지운다. 원문은 로그에 남긴다.
         */
        console.error(`[voicebento] 전사 워커 오류 (${recordingId}): ${workerError}`);
        return reject(new Error(scrubPaths(workerError)));
      }
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
      const tail = scrubPaths(stderrTail.trim().split("\n").slice(-6).join("\n")).slice(0, 600);
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
//   [B]+[C] 화자 분리 — **전사문 다음이고, 전사문을 못 건드린다**
// ─────────────────────────────────────────────────────────────

/**
 * 실루엣까지 뽑을 때 워커의 **봉우리** 메모리. `MB/분 × 분 + 기준`.
 *
 * 서술자의 `memory` 식(10.5MB/분 + 114MB)은 분리만 돌린 프로세스의 **끝**
 * RSS 다. 워커는 같은 프로세스에서 실루엣용 임베딩을 한 번 더 뽑으므로
 * 봉우리가 그보다 크다. uno 에서 `VmHWM`(진짜 봉우리)으로 잰 값:
 *
 *   15.7분 469MB · 49.3분 870MB  (실루엣까지)
 *   15.7분 298MB · 49.3분 529MB  (`--no-silhouette`)
 *
 * 긴 두 점을 잇는 선이 아래 값이다. 180분이면 약 2.4GB 로 서술자의 예산
 * (`memory.budgetMb` 2100MB)을 넘는다. 임베딩 스레드를 4→1 로 줄여도,
 * 분리 객체를 놓고 `gc()` 를 불러도 봉우리는 그대로였다 — 워커 쪽에서 줄일
 * 길이 없다. 그래서 **예산을 넘는 길이는 실루엣을 접는다** (아래 참조).
 */
const DIAR_PEAK_MB_PER_MINUTE = 11.9;
const DIAR_PEAK_MB_BASE = 281;
/**
 * `--no-silhouette` 일 때의 봉우리. 위 두 점(298MB · 529MB)을 이은 선이다 —
 * 두 점짜리 어림이라 180분(약 1.4GB)은 **늘려 잡은 값**이지 잰 값이 아니다.
 */
const DIAR_PEAK_NOSIL_MB_PER_MINUTE = 6.9;
const DIAR_PEAK_NOSIL_MB_BASE = 190;

/** 이 길이를 이 방식으로 나눌 때 워커 봉우리 어림 (MB). */
function diarPeakMb(seconds: number, silhouette: boolean): number {
  const min = seconds / 60;
  return silhouette
    ? min * DIAR_PEAK_MB_PER_MINUTE + DIAR_PEAK_MB_BASE
    : min * DIAR_PEAK_NOSIL_MB_PER_MINUTE + DIAR_PEAK_NOSIL_MB_BASE;
}

/**
 * 화면으로 가는 워커 오류 꼬리에서 **파일 경로를 지운다.**
 *
 * stderr 는 스택 줄마다 `/app/scripts/diarize.mjs:123` 같은 경로를 싣고, ffmpeg 은
 * 작업 폴더의 입력 파일 경로를 적는다. 그 문장이 그대로 `speakerError` 가 되어
 * 화면에 뜬다 — 사람에게는 쓸모가 없고, 배포의 폴더 구조와 녹음 id 가 드러난다.
 * 로그(`console.error`)에는 부르는 쪽이 원문을 남기므로 진단은 잃지 않는다.
 *
 * **워커가 `error` 줄로 스스로 낸 문장도 여기를 지난다.** 그 문장은 사람 말이라 안전해
 * 보이지만 안에 경로가 실린다 — `require()` 실패는 Node 가 "Require stack" 에 파일
 * 경로를 붙이고, "모델 파일이 없습니다: /models/…" 는 경로를 그대로 적는다. 예전에는
 * stderr 꼬리만 지워서 그 문장이 경로째 `speakerError` 로 화면에 떴다.
 *
 * 윈도 경로는 드라이브 글자부터 공백 앞까지 통째로 지운다. 뒤의 일반 규칙은 조각이
 * 둘 이상일 때만 걸려서 `C:\Program` 같은 한 조각짜리 머리가 남는다.
 */
function scrubPaths(text: string): string {
  return text
    .replace(/file:\/\/\/?[^\s'"()<>]+/g, "<경로>")
    .replace(/\b[A-Za-z]:[\\/][^\s'"()<>]*/g, "<경로>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"()<>:]+){2,}(?::\d+(?::\d+)?)?/g, "<경로>");
}

/**
 * 다시 전사한 녹음에서 이번 판이 화자를 **새로 못 나눴으면** 남겨 둔 구간으로 다시 붙인다.
 *
 * `clearSegments` 는 분리 행(구간 · 목소리 이름)을 남긴다. 이번 판이 새로 나누면 그
 * 행이 옛 판이 되어 이름이 목소리를 따라 옮겨지고 여기는 할 일이 없다. 새로 못 나눴으면
 * (모델 파일이 빠졌거나 워커가 죽었으면) 이름 표는 있는데 새 조각에는 화자가 하나도
 * 없다 — 소리가 같으니 남겨 둔 구간으로 붙이면 된다.
 *
 * 실패 이유는 지우지 않고 **덧붙인다.** 이번에 못 나눈 것은 사실이고, 사람은 줄에 뜬
 * 화자가 지난번 판이라는 것을 알아야 한다.
 *
 * **던지지 않는다.** 이 앞에서 전사문은 이미 온전하다.
 */
function reattachIfNotSplit(recordingId: string): void {
  try {
    const row = getRecordingRow(recordingId);
    if (!row || row.speakerState === "done") return;
    const n = reattachStoredDiarization(recordingId, diarModel.switchPenalty);
    /*
     * **실제로 붙였을 때만** "다시 붙여 두었습니다" 를 말한다. null(붙일 것이 없어 아무것도 안
     * 썼다)과 0(붙인 조각이 없다)은 둘 다 붙이지 않은 것이다 — 예전에는 null 만 봐서, 조각
     * 0개로 끝난 다시 전사에 아무것도 안 붙이고도 그 문장을 덧붙였다.
     */
    if (!n) return;
    setRecordingState(recordingId, {
      speakerError: `${row.speakerError ?? "이번에는 화자를 새로 나누지 못했습니다."} 지난번에 나눈 화자를 새 전사문에 다시 붙여 두었습니다.`.slice(
        0,
        1000,
      ),
    });
    console.log(`[voicebento] 남겨 둔 화자 구간으로 다시 붙임 (${recordingId}): 조각 ${n}`);
  } catch (e) {
    console.error(
      `[voicebento] 남겨 둔 화자 구간으로 다시 붙이지 못함 (${recordingId}):`,
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * 화자 분리 한 판. **이 함수는 던지지 않는다.**
 *
 * 실패는 전부 `speakerState`·`speakerError` 에 적고 조용히 돌아온다. 전사문이
 * 화자 분리보다 먼저이기 때문이다 — 여기서 던지면 `run()` 의 catch 가
 * `state` 를 `failed` 로 옮기고, 멀쩡히 읽히는 전사문이 빨간 글씨를 단다.
 */
async function diarize(
  recordingId: string,
  wavPath: string,
  duration: number | null,
): Promise<void> {
  try {
    const skip = whyNotDiarize(recordingId, wavPath, duration);
    if (skip) {
      setRecordingState(recordingId, { speakerState: "skipped", speakerError: skip });
      return;
    }

    const seconds = duration!;
    /*
     * **`state` 를 먼저 옮기고 `speakerState` 를 나중에 세운다.** 순서가 중요하다.
     *
     * 그 사이에 앱이 죽으면 어느 쪽이 남아 있느냐가 회수의 갈림길이 된다.
     * `diarizing` 이 남아 있으면 회수는 "전사는 끝났다" 로 읽고 `done` 으로
     * 접는다. 거꾸로 `transcribing` 인 채로 `speakerState` 만 `running` 이면
     * 회수가 **전사를 다시 줄 세우고 `clearSegments` 로 전사문을 지운다** —
     * 이미 다 나온 전사문을 잃는 길이다.
     *
     * 단계 이름을 옮기는 것 자체의 값도 있다: `transcribing` 에 숨기면
     * 60분짜리에서 7~9분 동안 진행 막대가 멎은 채로 "전사 중" 이라고 적혀 있다.
     */
    setRecordingState(recordingId, { state: "diarizing", progress: null }, [
      "transcribing",
      "extracting",
      "queued",
    ]);
    setRecordingState(recordingId, { speakerState: "running", speakerError: null });

    const roster = getRoster(recordingId);
    const clusters = clusterCountFor(diarModel, roster.length);

    /*
     * **예산을 넘으면 실루엣을 접는다.** 분리를 포기하지 않는다.
     *
     * 실루엣이 없으면 "이 녹음은 목소리가 잘 안 갈렸다" 를 말할 수 없을 뿐
     * (`silhouetteMedian` 이 null 로 남는다), 누가 말했는지는 그대로 나온다.
     * 그 둘 중 무엇을 버릴지는 물어볼 것도 없다.
     */
    const silhouette = diarPeakMb(seconds, true) <= diarModel.memory.budgetMb;

    const out = await runDiarWorker(recordingId, wavPath, {
      clusters,
      silhouette,
      seconds,
    });

    if (!out.turns.length) {
      /*
       * 구간이 하나도 없다. 워커는 이것을 실패로 안 본다 (무음 30초에
       * `turns` 빈 목록 · exit 0). 사람에게는 이유를 말해 준다 — 그리고
       * 전사문은 멀쩡하다.
       */
      setRecordingState(recordingId, {
        speakerState: "failed",
        speakerError:
          "소리에서 말하는 사람을 찾지 못했습니다. 전사문은 그대로 있습니다.",
      });
      return;
    }

    // ── [C] 낱말에 붙인다. 여기부터는 순수 JS 라 죽을 길이 없다 ──
    const segments = listSegmentsForAssign(recordingId);
    const sil: SilTurn[] = out.silhouette;
    const result = assignSpeakers({
      segments,
      turns: out.turns,
      silhouette: sil,
      switchPenalty: diarModel.switchPenalty,
    });

    const median = silhouetteMedian(sil);
    /*
     * 실루엣을 **왜 못 쟀나**를 적는다. 못 잰 판은 파일 경고도 줄마다의 "덜
     * 확실하다" 도 붙을 수 없어서, 이유를 안 적으면 화면이 "잘 갈렸다" 와 같은
     * 얼굴이 된다 (`DiarizationDTO.silhouetteMissing`).
     */
    const silhouetteNote =
      median !== null
        ? null
        : !silhouette
          ? `${Math.round(seconds / 60)}분짜리라 메모리를 아끼려고 화자 신뢰도는 재지 않았습니다 ` +
            "(누가 말했는지는 그대로 나눴습니다)."
          : (out.silhouetteLost ?? "화자 분리 엔진이 신뢰도 값을 내지 않았습니다.");

    /*
     * 분리 행(이름 옮기기 포함)과 조각마다의 화자를 **한 트랜잭션으로** 앉힌다.
     * 그 사이에 죽으면 새 판의 이름 표가 옛 판 번호를 단 줄 옆에 앉는다.
     */
    const changed = commitDiarization(
      {
        recordingId,
        modelId: diarModel.id,
        roster,
        clusters,
        found: out.speakers,
        // 날 구간에 실루엣을 합쳐 **한 벌로** 둔다. 다시 붙일 때 이것만 있으면 된다.
        turns: mergeSilhouette(out.turns, sil),
        talkTime: result.talkTime,
        silhouetteMedian: median,
        silhouetteNote,
        msProcess: out.msProcess,
      },
      result.segments,
    );

    setRecordingState(recordingId, { speakerState: "done", speakerError: null });
    console.log(
      `[voicebento] 화자 구분 (${recordingId}): 군집 ${out.speakers}/${clusters} · ` +
        `구간 ${out.turns.length} · 조각 ${changed}/${segments.length}` +
        (silhouette ? "" : " · 실루엣 접음(메모리)"),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setRecordingState(recordingId, {
      speakerState: "failed",
      /*
       * **경로를 지워 싣는다.** 여기로 오는 문장에는 워커가 `error` 줄로 낸 것이 있고
       * (`runDiarWorker`), 그 안에 "Require stack" 이나 모델 파일 경로가 실려 온다.
       * 한 곳에서 지우면 앞으로 생길 실패 갈래도 빠뜨리지 않는다. 원문은 아래 로그에.
       */
      speakerError: scrubPaths(message).slice(0, 1000),
    });
    console.error(`[voicebento] 화자 구분 실패 (${recordingId}):`, message);
  }
}

/**
 * 지금 분리를 **안 할** 이유. 없으면 null.
 *
 * 돌려주는 문장이 그대로 화면에 뜬다. "건너뛰었다" 는 거절이 아니라 사실의
 * 보고이고, 전사문은 어느 쪽이든 그대로 나온다.
 */
function whyNotDiarize(
  recordingId: string,
  wavPath: string,
  duration: number | null,
): string | null {
  if (countSegments(recordingId) === 0) {
    return "옮겨 적은 말이 없어 화자를 나눌 곳이 없습니다.";
  }
  if (duration === null || !(duration > 0)) {
    return "소리 길이를 몰라 화자를 나누지 못했습니다.";
  }
  if (!existsSync(wavPath)) {
    return "화자를 나눌 소리 파일이 남아 있지 않습니다.";
  }
  if (!existsSync(diarPaths.seg) || !existsSync(diarPaths.emb)) {
    /*
     * 모델 파일이 없다. **전사는 이미 끝났다** — 이건 실패가 아니라 이 앱에
     * 그 기능이 아직 없는 상태다 (`scripts/fetch-model.mjs` 가 분리 실패를
     * 제 안에서 삼키는 것과 같은 규율이다).
     */
    return "화자 분리 모델이 아직 준비되지 않았습니다. 전사문은 그대로 나옵니다.";
  }
  if (!canDiarize(diarModel, duration)) {
    const limit = Math.round(diarModel.runtime.maxAudioSeconds / 60);
    return (
      `${Math.round(duration / 60)}분짜리라 화자를 나누지 않았습니다 (상한 ${limit}분). ` +
      "이보다 길면 화자 분리가 메모리를 다 써서 멈춥니다 — 전사문은 그대로입니다."
    );
  }
  /*
   * **목록이 없으면 안 나눈다.** 워커를 띄우지 않으니 CPU 도 줄도 안 쓴다.
   *
   * 올리기 화면에서 목록을 안 적으면 여기로 온다. 예전에는 최소 1명을 깔아 k=3
   * 으로 돌렸고, 그러면 `other` 가 없고 부스러기에도 "화자 3" 이 붙고 셋 넘는
   * 회의는 매번 k < L+2 였다 (`ROSTER_MISSING` 의 설명). 이 검사를 맨 뒤에 둔
   * 까닭: 모델이 없거나 너무 긴 녹음에 "목록을 적으세요" 라고 하면, 사람이
   * 적고 나서야 진짜 이유를 듣는다.
   */
  if (getRoster(recordingId).length === 0) {
    return ROSTER_MISSING;
  }
  return null;
}

/** 날 구간에 실루엣을 합친다. 워커가 0.2초 미만 구간은 건너뛰므로 없을 수 있다. */
function mergeSilhouette(
  turns: DiarTurn[],
  sil: SilTurn[],
): { s: number; e: number; k: number; sil: number | null }[] {
  const key = (t: DiarTurn) => `${t.k}|${t.s}|${t.e}`;
  const lookup = new Map(sil.map((g) => [key(g), g.sil]));
  return turns.map((t) => ({ s: t.s, e: t.e, k: t.k, sil: lookup.get(key(t)) ?? null }));
}

interface DiarOutput {
  turns: DiarTurn[];
  silhouette: SilTurn[];
  /** 실제로 나온 군집 수. */
  speakers: number;
  msProcess: number | null;
  /** 구간은 받았는데 실루엣을 재다 워커가 끝났으면 그 사실 (사람 말). */
  silhouetteLost: string | null;
}

/**
 * 분리 워커를 띄우고 그 말을 받아 적는다.
 *
 * ## `turns` 를 쥔 채로 죽으면 그것을 쓴다
 *
 * 워커는 `turns` 를 실루엣보다 **먼저** 내보낸다. 99분짜리를 `-m 1g` 에
 * 넣어 보니 분리는 끝났고(구간 1,019개, 그 줄 34KB 가 온전히 나왔다)
 * 임베딩 단계에서 SIGKILL(137) 이 왔다 — 부모가 본 것은 `meta` ·
 * `stage segmenting` · `turns` · `stage embedding` 넷과 종료 코드 137 이다.
 *
 * **`done` 이 없으면 신뢰도가 없는 것이지 분리가 실패한 것이 아니다.**
 * 그래서 구간을 받아 두었으면 죽어도 그것으로 붙인다. 잃는 것은 실루엣
 * 하나이고, 그건 원래 "덜 확실하다" 밖에 말 못 하는 값이다.
 */
function runDiarWorker(
  recordingId: string,
  wavPath: string,
  opts: { clusters: number; silhouette: boolean; seconds: number },
): Promise<DiarOutput> {
  return new Promise((resolve_, reject) => {
    const script = join(process.cwd(), "scripts", "diarize.mjs");
    const args = [
      script,
      "--wav", resolve(wavPath),
      /*
       * 성질은 **부모가 골라서 넘긴다.** `transcribe.mjs` 와 같은 규율이다 —
       * 워커가 제 손으로 서술자 표를 다시 읽으면, 환경변수가 어긋난 날 둘이
       * 다른 설정으로 도는데 그 어긋남이 아무 데도 안 보인다.
       */
      "--spec", JSON.stringify(diarModel.runtime),
      "--clusters", String(opts.clusters),
      /*
       * 모델 파일 자리는 서술자에 없다 (`DiarRuntimeSpec` 에 `files` 칸이
       * 없다). 분리 모델이 어느 칸에 앉을지는 배포가 정한다 — 전사 모델
       * 자리에서 짐작할 일이 아니다 (`env.ts` 의 `DIAR_MODEL_DIR`).
       */
      "--seg", resolve(diarPaths.seg),
      "--emb", resolve(diarPaths.emb),
      "--threads", String(diarThreads),
    ];
    if (!opts.silhouette) args.push("--no-silhouette");

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // 워커는 이 앱의 환경변수를 볼 이유가 없다. 인자로 다 넘긴다.
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
    });
    queue.running.set(recordingId, child);

    const out: DiarOutput = {
      turns: [],
      silhouette: [],
      speakers: 0,
      msProcess: null,
      silhouetteLost: null,
    };
    let workerError: string | null = null;
    let stderrTail = "";
    let settled = false;
    let done = false;

    /*
     * **말없이 도는 시간을 못 재는 단계가 있다.**
     *
     * `sd.process()` 한 번이 시간의 대부분이고 그 안에서는 중간 산출이 하나도
     * 안 나온다 (그래서 워커에 진행률이 없다). 전사처럼 "15분 조용하면 멎은
     * 것" 으로 재면 긴 파일이 멀쩡히 도는 중에 죽는다. 그래서 잣대는 하나,
     * **전체 시간**이다. 어림(RTF 0.27)의 세 배를 주고 바닥을 20분으로 깐다.
     */
    const budgetMs = Math.max(
      20 * 60_000,
      estimateDiarSeconds(diarModel, opts.seconds) * 1000 * 3,
    );
    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - startedAt > budgetMs) {
        workerError = `화자 구분이 너무 오래 걸려 멈췄습니다 (${Math.round(budgetMs / 60000)}분).`;
        child.kill("SIGKILL");
      }
    }, 30_000);

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line) as Record<string, unknown>;
          switch (m.type) {
            case "turns":
              out.turns = readTurns(m.segments);
              out.speakers = num(m.speakers) ?? 0;
              break;
            case "silhouette":
              out.silhouette = readSil(m.values);
              break;
            case "done":
              out.msProcess = num(m.msProcess);
              done = true;
              break;
            case "error":
              workerError = typeof m.message === "string" ? m.message : "화자 구분에 실패했습니다";
              break;
            default:
              break;
          }
        } catch {
          console.warn(`[voicebento] 분리 워커가 이상한 줄을 보냈습니다: ${line.slice(0, 200)}`);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      reject(new Error(`화자 분리 워커를 띄우지 못했습니다: ${e.message}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);

      if (code === 0 && !workerError) return resolve_(out);

      // 구간을 이미 받았으면 그것으로 간다. 위 설명 참조.
      if (out.turns.length && !workerError) {
        console.warn(
          `[voicebento] 분리 워커가 ${signal ?? code} 로 끝났지만 구간 ${out.turns.length}개는 ` +
            `받았습니다 (${done ? "done 옴" : "done 없음 — 실루엣 없이 붙입니다"}).`,
        );
        if (!done) {
          out.silhouette = [];
          out.silhouetteLost =
            code === 137 || signal === "SIGKILL"
              ? "화자 분리 엔진이 누가 말했는지를 나눈 뒤, 신뢰도를 재다가 메모리가 모자라 멈췄습니다."
              : `화자 분리 엔진이 누가 말했는지를 나눈 뒤, 신뢰도를 재다가 멈췄습니다 (${signal ?? code}).`;
        }
        return resolve_(out);
      }

      if (workerError) return reject(new Error(workerError));
      console.error(`[voicebento] 분리 워커 stderr (${recordingId}):\n${stderrTail.slice(-2000)}`);
      reject(new Error(diarDeathMessage(code, signal, stderrTail, opts.seconds, opts.silhouette)));
    });
  });
}

/**
 * 워커가 왜 죽었나를 **사람 말로.**
 *
 * 종료 코드를 그대로 적으면 안 된다. 특히 137 은 stderr 가 비어 있는 것이
 * **정상**이다 — cgroup 이 SIGKILL 을 보내면 JS 오류도 마지막 출력 한 줄도
 * 없다. 그 자리에 "알 수 없는 오류" 라고 적으면 사람은 앱이 고장 난 줄 알고
 * 같은 파일을 몇 번씩 다시 올린다. 실제 원인은 하나뿐이다: 메모리.
 */
function diarDeathMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
  seconds: number,
  silhouette: boolean,
): string {
  // 경로는 지운다 (`scrubPaths`). 원문은 부르는 쪽이 로그에 남겼다.
  const tail = scrubPaths(stderrTail.trim().split("\n").slice(-6).join("\n")).slice(0, 600);

  if (code === 137 || signal === "SIGKILL") {
    /*
     * 필요한 메모리는 **워커의 실측 봉우리 선**으로 어림한다. 서술자의 `memory`
     * 식(10.5MB/분 + 114MB)은 분리만 돈 프로세스의 끝 RSS 라 봉우리보다 작다 —
     * 그 값을 대면 "그만큼은 줬는데 왜 죽나" 가 된다. 이번 판이 실루엣을 접었으면
     * 접은 쪽의 선을 쓴다.
     */
    const need = Math.round(diarPeakMb(seconds, silhouette));
    return (
      `메모리가 모자라 화자 구분이 멈췄습니다 (SIGKILL). ` +
      `${Math.round(seconds / 60)}분짜리를 나누려면 약 ${need}MB 가 필요합니다. ` +
      `전사문은 그대로 있습니다. 파일을 나눠 올리면 화자까지 나옵니다.`
    );
  }
  if (code === 134 || signal === "SIGABRT") {
    return (
      "화자 분리 엔진이 도중에 죽었습니다 (코드 134). 전사문은 그대로 있습니다." +
      (tail ? `\n${tail}` : "")
    );
  }
  return (
    `화자 분리 워커가 ${signal ?? code} 로 끝났습니다. 전사문은 그대로 있습니다.` +
    (tail ? `\n${tail}` : "")
  );
}

/** 워커가 보낸 구간. 모양이 어긋난 것은 버린다 (fail closed). */
function readTurns(v: unknown): DiarTurn[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const { s, e, k } = x as Record<string, unknown>;
    if (typeof s !== "number" || typeof e !== "number" || typeof k !== "number") return [];
    if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isInteger(k)) return [];
    if (e <= s) return [];
    return [{ s, e, k }];
  });
}

function readSil(v: unknown): SilTurn[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const { s, e, k, sil } = x as Record<string, unknown>;
    if (typeof s !== "number" || typeof e !== "number" || typeof k !== "number") return [];
    if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isInteger(k)) return [];
    return [{ s, e, k, sil: typeof sil === "number" && Number.isFinite(sil) ? sil : null }];
  });
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
