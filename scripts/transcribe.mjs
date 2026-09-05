#!/usr/bin/env node
/**
 * 전사 워커. **독립 프로그램이다 — 앱과 같은 프로세스에서 절대 돌리지 마라.**
 *
 * ## 왜 자식 프로세스인가
 *
 * `sherpa-onnx-node` 의 오류는 C++ 의 `Ort::Exception` 이고, 그것이 N-API 를
 * 넘어오면서 `std::terminate()` 를 부른다. `try/catch` 로도,
 * `process.on("uncaughtException")` 으로도 **안 잡힌다.** 프로세스가 종료
 * 코드 134(SIGABRT)로 그냥 죽는다. Next 서버 안에서 돌리면 긴 파일 하나가
 * 앱 전체를 죽인다 — 메일함·메모함과 한 스택에 있는 앱에서 그건 재앙이다.
 *
 * 그래서 여기서 죽는 것은 여기서 끝난다. 부모는 종료 코드를 보고 그 녹음
 * 하나만 실패로 접는다.
 *
 * ## 반드시 지키는 넷 (전부 uno 에서 실측한 근거가 있다)
 *
 * 1. 자식 프로세스 — 위.
 * 2. **VAD 로 자른 뒤 조각마다 디코딩.** 통짜로 넣으면 401초에서 죽는다:
 *    내보낸 ONNX 의 상대 위치 임베딩이 5,000프레임(=400초)에 고정이다.
 *    메모리도 초선형으로 는다(360초에 5.23GB). VAD 를 쓰면 60분도 1.60GB.
 *    `maxSpeechDuration: 30` 을 걸어 400초 리밋을 **구조적으로** 막는다 —
 *    그 값이 있는 한 400초짜리 조각은 만들어질 수 없다.
 *    덤으로 정확도도 좋아진다. 통짜로 넣었더니 언어가 섞인 파일에서 한 언어가
 *    통째로 사라졌다.
 * 3. **numThreads 는 4.** 8은 2보다도 느리다(물리 4코어에 논리 8).
 *    10분 오디오 실측: 1→97.5s · 2→67.3s · 4→57.0s · 8→78.7s.
 * 4. **ffmpeg 로 16kHz 모노 WAV 정규화.** `readWave` 는 RIFF WAV PCM 만 읽는다.
 *    mp3·mp4 는 못 읽고 그 실패는 `TypeError` 로 온다(이건 잡힌다).
 *    비용은 무시해도 된다 — 60분 mp3 → 1.75초.
 *
 * ## 부모와 이야기하는 법
 *
 * stdout 에 JSON 을 **한 줄에 하나씩** 흘린다. stderr 는 사람이 읽는 로그다.
 * 부모(`src/lib/transcribe.ts`)가 줄마다 받아 DB 에 적는다 — 조각 하나가
 * 끝날 때마다 적히므로, 55분째에 죽어도 그때까지의 55분은 남는다.
 *
 *   {"type":"stage","stage":"extracting"|"transcribing"}
 *   {"type":"meta","duration":3600.0,"sampleRate":16000}
 *   {"type":"segment","idx":0,"start":1.2,"end":8.5,"text":"…","words":[{"w":"…","t":1.2}]}
 *   {"type":"progress","processed":8.5}
 *   {"type":"done","segments":123,"empty":3,"speech":2841.2}
 *   {"type":"error","message":"…"}
 *
 * ## 모델의 성질은 **인자로 온다**
 *
 * 파일 이름도, 표본율도, VAD 상한도 여기 박혀 있지 않다. 부모가 서술자에서
 * 골라 `--spec` 에 JSON 으로 실어 준다 (`src/lib/asr-models.ts`).
 *
 * 워커가 제 손으로 서술자 표를 읽게 하지 않는 이유: 환경변수가 어긋난 날
 * (부모는 새 모델, 워커는 기본값) 둘이 다른 모델로 도는데 그 어긋남이 아무
 * 데도 안 보인다. 나오는 것은 그냥 이상한 전사문이다. 부모가 고르고 워커가
 * 따르면 그런 갈림길이 없다.
 *
 * 손으로 돌려 볼 때를 위해 `--model <id>` 도 받는다. 그때만 옆의
 * `asr-models.json` 을 읽는다.
 *
 * ## 결과 모양 어댑터
 *
 * 모델마다 sherpa 에 주는 설정과 돌려주는 것이 다르다.
 *
 * - `transducer` (parakeet) — encoder/decoder/joiner. `tokens` 와
 *   `timestamps` 를 주므로 낱말로 묶을 수 있다.
 * - `whisper` — encoder/decoder 만. **시각을 하나도 안 준다**
 *   (`result.timestamps` 가 빈 배열이다 — 실측). 그때는 낱말 시각 없이
 *   조각의 시작·끝만 내보내고, 화면이 낱말 클릭을 접는다.
 *
 * 아래 `RECOGNIZERS` 가 그 갈림길이고, 모델을 하나 더 붙일 때 손대는 곳은
 * 서술자 한 칸과 (파일 구성이 다르면) 여기 한 칸이 전부다.
 *
 * 실행:
 *   node scripts/transcribe.mjs --input <원본> --wav <내보낼 WAV> \
 *        --model-dir <모델 폴더> --spec '<서술자 JSON>' \
 *        [--vad <silero_vad.onnx>] [--threads 4] [--ffmpeg ffmpeg]
 *
 *   손으로 돌릴 때: --spec 대신 --model parakeet-tdt-0.6b-v3-int8
 *
 * `--vad` 를 안 주면 모델 폴더 안에서 찾는다. 스택 배포는 VAD 가 모델 폴더
 * 밖에 있어서 그 자리를 따로 넘긴다 (`src/lib/env.ts` 의 `modelPaths`).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────
//   부모에게 말하기
// ─────────────────────────────────────────────────────────────

/**
 * 한 줄에 하나씩. **`process.stdout.write` 를 직접 쓴다.**
 *
 * `console.log` 도 결국 같은 곳으로 가지만, 여기서 나가는 것은 사람이 읽는
 * 글이 아니라 부모가 파싱하는 자료다. 다른 무엇도 stdout 으로 나가면 안 된다는
 * 뜻을 코드 모양으로 남겨 둔다 — 진단은 전부 `log()` 로 stderr 에 쓴다.
 */
function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.error("[transcribe]", ...args);
}

function fail(message) {
  emit({ type: "error", message: String(message).slice(0, 2000) });
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//   인자
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * 인자는 `main()` 안에서 읽는다. **모듈 껍데기에서 읽지 않는다.**
 *
 * 이 파일에서 `groupWords()` 하나만 꺼내 시험해 보고 싶은 때가 있다. 껍데기에
 * 인자 검사와 `process.exit` 가 있으면 import 하는 순간 그것들이 먼저 돌아
 * "인자가 없다" 로 죽는다 — 실제로 그랬다. 아래 `isMain` 갈림길이 그 길을 막는다.
 */
/**
 * 서술자를 손에 쥔다. `--spec` 이 먼저고, 없으면 `--model` 로 표에서 찾는다.
 *
 * **아는 모양만 받는다.** 부모가 보낸 것이라 믿어도 될 것 같지만, 여기서
 * 안 보면 잘못된 값이 sherpa 까지 내려가고 거기서 나는 오류는 C++ 예외라
 * 프로세스를 통째로 죽인다 (그게 이 워커가 자식 프로세스인 이유다).
 * 여기서 걸러 내면 사람이 읽을 수 있는 문장 하나로 끝난다.
 */
function readSpec(args) {
  let spec;
  if (args.spec) {
    try {
      spec = JSON.parse(args.spec);
    } catch (e) {
      fail(`--spec 이 JSON 이 아닙니다: ${e.message}`);
    }
  } else if (args.model) {
    // 손으로 돌릴 때만 지나는 길. 평소에는 부모가 --spec 을 준다.
    const table = JSON.parse(
      readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "asr-models.json"), "utf8"),
    );
    const found = table.models?.[args.model];
    if (!found) {
      fail(
        `모르는 모델 id 입니다: ${args.model}. ` +
          `아는 것: ${Object.keys(table.models ?? {}).join(", ")}`,
      );
    }
    spec = found.runtime;
  } else {
    fail("--spec (또는 손으로 돌릴 때 --model) 이 필요합니다");
  }

  const kind = spec?.kind;
  if (!RECOGNIZERS[kind]) {
    fail(
      `서술자의 kind 를 모릅니다: ${JSON.stringify(kind)}. ` +
        `아는 것: ${Object.keys(RECOGNIZERS).join(", ")}. ` +
        `새 모델을 붙이려면 이 파일의 RECOGNIZERS 에 어댑터를 하나 더해야 합니다.`,
    );
  }
  const f = spec.files ?? {};
  if (!f.encoder || !f.decoder || !f.tokens) {
    fail("서술자에 encoder·decoder·tokens 파일 이름이 있어야 합니다");
  }
  if (spec.sampleRate !== 16000) {
    // silero VAD 가 다른 표본율을 아예 거절한다. 그 거절은 C++ 에서 나온다.
    fail(`서술자의 sampleRate 가 ${spec.sampleRate} 입니다. silero VAD 는 16000 만 받습니다.`);
  }
  const vad = spec.vad ?? {};
  if (!(vad.maxSpeechDuration > 0) || !(vad.windowSize > 0)) {
    fail("서술자에 VAD 설정(maxSpeechDuration·windowSize)이 있어야 합니다");
  }
  /*
   * **이 검사가 이 파일에서 가장 중요한 검사다.**
   *
   * 모델 상한을 넘는 조각이 들어가면 죽는다 (parakeet 은 400초에서
   * 위치 임베딩이 터진다). VAD 상한을 그보다 작게 걸어 두면 그런 조각이
   * **만들어질 수 없다** — "조심해서 자르자" 가 아니라 구조적으로 불가능하게
   * 만드는 것이 요점이다. 서술자 쪽에도 같은 불변식이 있지만
   * (`asr-models.ts` 의 `assertModel`), 손으로 --spec 을 만들어 넣는 길이
   * 있는 한 여기서도 봐야 한다.
   */
  if (spec.maxAudioSeconds != null && vad.maxSpeechDuration >= spec.maxAudioSeconds) {
    fail(
      `VAD 조각 상한(${vad.maxSpeechDuration}초)이 모델 상한(${spec.maxAudioSeconds}초)보다 ` +
        `작지 않습니다. 이대로면 모델을 넘어뜨리는 조각이 만들어질 수 있습니다.`,
    );
  }
  return spec;
}

function readArgs() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const wav = args.wav;
  const modelDir = args["model-dir"];
  if (!input || !wav || !modelDir) {
    fail("--input, --wav, --model-dir 이 모두 필요합니다");
  }
  const spec = readSpec(args);

  /*
   * 파일 **이름**은 서술자가 정하고 **자리**는 인자가 정한다.
   *
   * 갈라 둔 이유: 배포 모양에 따라 폴더가 다르지만(우리가 받은 자리 ·
   * 스택이 읽기 전용으로 물려 준 자리) 그 안의 파일 이름은 모델이 정한다.
   */
  const files = { tokens: join(modelDir, spec.files.tokens) };
  for (const key of ["encoder", "decoder", "joiner"]) {
    if (spec.files[key]) files[key] = join(modelDir, spec.files[key]);
  }

  return {
    input,
    wav,
    spec,
    // 스레드도 서술자에 기본값이 있다. 인자가 오면 그쪽이 이긴다.
    threads: Number(args.threads ?? spec.defaultThreads ?? 4) || 4,
    ffmpeg: args.ffmpeg || "ffmpeg",
    model: {
      ...files,
      /*
       * VAD 는 **인자로 받는다.** 모델 폴더 안에 있다고 짐작하지 않는다.
       *
       * 이 앱이 직접 받았으면 거기 함께 있지만, bento 스택에 얹히면 호스트가
       * 미리 받아 둔 것을 읽기 전용으로 물려 받는다 — 그때는 모델 폴더보다
       * 한 칸 위(`/models/silero_vad.onnx`)에 있다. 안 넘기면 옛 자리를 쓴다.
       */
      vad: args.vad || join(modelDir, "silero_vad.onnx"),
    },
  };
}

// ─────────────────────────────────────────────────────────────
//   1단계 — ffmpeg 로 16kHz 모노 WAV
// ─────────────────────────────────────────────────────────────

/**
 * 영상이면 소리만 뽑고, 소리면 표본율과 채널만 맞춘다.
 *
 * `-vn` 이 영상 트랙을 버린다. 소리 트랙이 아예 없으면 ffmpeg 가
 * "does not contain any stream" 으로 실패하는데, 그 말을 그대로 사람에게
 * 넘기면 무슨 뜻인지 모른다 — 아래에서 알아볼 수 있는 문장으로 바꾼다.
 *
 * `-nostdin` 이 없으면 ffmpeg 가 부모의 stdin 을 삼켜 자식 프로세스로
 * 띄웠을 때 이상하게 멎는 일이 있다.
 */
function extractAudio(cfg) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      cfg.ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", cfg.input,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-acodec", "pcm_s16le",
        "-f", "wav",
        "-y", cfg.wav,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    ff.stderr.on("data", (b) => {
      stderr += b.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    ff.on("error", (e) => {
      reject(
        new Error(
          e.code === "ENOENT"
            ? `ffmpeg 을 찾지 못했습니다 (${cfg.ffmpeg}). 이미지에 정적 바이너리가 들어 있어야 합니다.`
            : `ffmpeg 을 띄우지 못했습니다: ${e.message}`,
        ),
      );
    });

    ff.on("close", (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().slice(-600);
      if (/does not contain any stream|Output file .* is empty/i.test(stderr)) {
        return reject(new Error("이 파일에는 소리 트랙이 없습니다 (영상만 들어 있습니다)."));
      }
      if (/Invalid data found|moov atom not found|End of file/i.test(stderr)) {
        return reject(
          new Error(`파일이 깨졌거나 아는 형식이 아닙니다. ffmpeg: ${tail}`),
        );
      }
      reject(new Error(`ffmpeg 이 ${code} 로 끝났습니다: ${tail}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────
//   낱말 묶기
// ─────────────────────────────────────────────────────────────

/**
 * 토큰을 낱말로 묶는다. **모델이 주는 `words` 는 늘 비어 있다.**
 *
 * SentencePiece 라 낱말의 **첫 토큰에만** 앞 공백이 붙는다:
 *   [" co", "un", "tr", "y"] → "country", 시각은 " co" 것.
 * 그래서 앞 공백(또는 `▁`)을 만나면 새 낱말을 시작하고, 아니면 앞 낱말에
 * 이어 붙인다. 낱말의 시각은 첫 토큰의 시각이다 — 낱말을 눌러 그 자리로
 * 뛰는 데 쓰는 값이고, 실측 오차가 ±0.3초 안쪽이라 충분하다.
 */
/**
 * 조각 하나의 결과에서 낱말과 시각을 뽑는다. **모델마다 갈린다.**
 *
 * `timestamps: "none"` 인 모델(sherpa-onnx 의 whisper)은 시각을 하나도 안
 * 준다. 그때 억지로 뽑으려 하면 안 된다 — `result.timestamps` 가 빈 배열이라
 * `groupWords` 가 모든 낱말에 0초를 붙이고, 화면에서 낱말을 누르면 **전부
 * 녹음 맨 앞으로 뛴다.** 아무 데도 안 뛰는 것보다 나쁘다. 거짓말이니까.
 *
 * 그래서 빈 배열을 낸다. 화면은 `ModelNoticeDTO.timestamps` 를 보고 낱말
 * 클릭을 통째로 접고, 줄 클릭(조각의 시작 시각)만 남긴다. 그건 조각 경계에서
 * 나온 값이라 이 모델에서도 정확하다.
 */
function extractWords(spec, result) {
  if (spec.timestamps === "none") return [];
  return groupWords(result.tokens ?? [], result.timestamps ?? []);
}

export function groupWords(tokens, timestamps) {
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (typeof tok !== "string") continue;
    const t = Number(timestamps?.[i]);
    const starts = /^[\s▁]/.test(tok);
    const piece = tok.replace(/^[\s▁]+/, "");
    if (starts || words.length === 0) {
      words.push({ w: piece, t: Number.isFinite(t) ? t : 0 });
    } else {
      words[words.length - 1].w += piece;
    }
  }
  return words.filter((w) => w.w.length > 0);
}

// ─────────────────────────────────────────────────────────────
//   결과 모양 어댑터 — 모델 갈래마다 하나
// ─────────────────────────────────────────────────────────────

/**
 * sherpa 에 줄 `modelConfig` 를 만든다. **모델을 하나 더 붙일 때 여기 한 칸.**
 *
 * 갈래마다 파일 구성과 칸 이름이 다르다. 서술자가 아무리 잘 적혀 있어도
 * 이 모양은 sherpa 쪽 계약이라 코드로 알아야 한다 — 그래서 서술자에 안 담고
 * 여기 둔다. 서술자 = 사실, 여기 = 그 사실을 저쪽 모양으로 옮기는 법.
 */
const RECOGNIZERS = {
  transducer: (model, spec) => ({
    transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
    tokens: model.tokens,
    /*
     * 문서가 시키는 값이다 (`--model-type=nemo_transducer`).
     * 비워 두면 sherpa 가 encoder 의 ONNX 메타데이터를 읽어 알아내지만,
     * 내보내기 판본에 따라 그 칸이 비어 있는 것이 있다. 명시하면 그 갈림길이
     * 사라진다.
     */
    modelType: spec.modelType || "nemo_transducer",
  }),

  /**
   * whisper — **아직 아무도 안 쓴다.** 붙이는 자리가 실제로 열려 있는지
   * 확인하려고 적어 둔 갈래다.
   *
   * 두 가지가 transducer 와 다르다.
   * 1. joiner 가 없다. encoder/decoder 둘뿐이다.
   * 2. **시각을 안 준다.** 그 갈림길은 `extractWords` 에 있다.
   *
   * `language: ""` 는 whisper 가 스스로 알아맞히게 두는 값이다. 특정 언어로
   * 못 박으면 그 말이 아닌 자리에서 조용히 엉뚱한 글이 나온다.
   */
  whisper: (model, spec) => ({
    whisper: { encoder: model.encoder, decoder: model.decoder, language: "", task: "transcribe" },
    tokens: model.tokens,
    modelType: spec.modelType || "whisper",
  }),
};

// ─────────────────────────────────────────────────────────────
//   2단계 — VAD 로 자르고 조각마다 디코딩
// ─────────────────────────────────────────────────────────────

async function main() {
  const cfg = readArgs();
  const MODEL = cfg.model;
  const SPEC = cfg.spec;
  const THREADS = cfg.threads;

  for (const [name, path] of Object.entries(MODEL)) {
    if (!existsSync(path)) {
      fail(
        `모델 파일이 없습니다: ${path} (${name}). ` +
          `\`npm run model:fetch\` 로 볼륨에 내려받으세요.`,
      );
    }
  }

  let sherpa;
  try {
    sherpa = require("sherpa-onnx-node");
  } catch (e) {
    fail(
      `sherpa-onnx-node 를 불러오지 못했습니다: ${e.message}. ` +
        `\`npm run asr:install\` (= npm --prefix scripts install) 을 돌렸는지 확인하세요.`,
    );
  }

  emit({ type: "stage", stage: "extracting" });
  const t0 = Date.now();
  await extractAudio(cfg);
  log(`ffmpeg ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  /*
   * 여기부터는 sherpa 가 도는 구간이다. C++ 예외는 못 잡지만 JS 쪽 오류
   * (WAV 가 아니다 · 파일이 없다)는 잡히므로 감싸 둔다. 잡히는 것을
   * 안 잡으면 부모는 종료 코드만 보고 "왜" 를 모른다.
   */
  let wave;
  try {
    wave = sherpa.readWave(cfg.wav);
  } catch (e) {
    fail(`WAV 를 읽지 못했습니다: ${e.message}`);
  }

  const sampleRate = wave.sampleRate;
  /*
   * 서술자가 말하는 표본율이 아니면 여기서 멈춘다 (지금은 늘 16000이다).
   *
   * silero VAD 는 다른 표본율을 아예 거절한다 (`Expected sample rate 16000.
   * Given: 24000`). 그 거절은 C++ 에서 나오므로 잡을 수 없고, 잡히더라도
   * 그 문장만으로는 사람이 무엇을 잘못했는지 모른다. 앞 단계에서 ffmpeg 이
   * 늘 16k 로 맞추므로 여기 걸리면 그건 우리 쪽 실수라는 뜻이다.
   */
  if (sampleRate !== SPEC.sampleRate) {
    fail(
      `정규화한 WAV 가 ${sampleRate}Hz 입니다. ${SPEC.sampleRate}Hz 여야 합니다 — ` +
        `ffmpeg 인자(-ar ${SPEC.sampleRate})가 빠졌거나 다른 파일을 읽었습니다.`,
    );
  }
  const total = wave.samples.length / sampleRate;
  emit({ type: "meta", duration: total, sampleRate });
  log(`오디오 ${total.toFixed(1)}초 @ ${sampleRate}Hz`);

  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate, featureDim: SPEC.featureDim },
    modelConfig: {
      ...RECOGNIZERS[SPEC.kind](MODEL, SPEC),
      numThreads: THREADS,
      provider: "cpu",
      debug: 0,
    },
  });
  log(
    `모델 적재 ${((Date.now() - t0) / 1000).toFixed(2)}s ` +
      `(${SPEC.id ?? SPEC.kind}, threads=${THREADS}, timestamps=${SPEC.timestamps})`,
  );

  const windowSize = SPEC.vad.windowSize;
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: MODEL.vad,
        threshold: SPEC.vad.threshold,
        minSilenceDuration: SPEC.vad.minSilenceDuration,
        minSpeechDuration: SPEC.vad.minSpeechDuration,
        /*
         * **이 값이 이 파일에서 가장 중요한 숫자다.**
         *
         * 모델 상한(parakeet 은 400초 = 5,000프레임)을 넘는 조각이 들어가면
         * 죽는다. 그보다 작은 상한을 걸어 두면 그런 조각이 **만들어질 수
         * 없다** — 말이 그보다 길게 이어져도 VAD 가 거기서 끊어 준다.
         * "조심해서 자르자" 가 아니라 구조적으로 불가능하게 만드는 것이 요점이다.
         *
         * 이제 값은 서술자에서 온다 (parakeet 은 30). 모델마다 다른 값이고,
         * 모델 상한보다 작아야 한다는 것은 `readSpec` 이 이미 확인했다.
         */
        maxSpeechDuration: SPEC.vad.maxSpeechDuration,
        windowSize,
      },
      sampleRate,
      numThreads: 1,
      debug: false,
    },
    /*
     * 내부 원형 버퍼(초). 조각 하나가 여유롭게 들어갈 크기여야 한다 —
     * 작으면 긴 조각이 잘리고, 그 잘림은 아무 오류 없이 조용히 일어난다.
     * 상한의 두 배로 잡되 최소 60초.
     */
    Math.max(60, SPEC.vad.maxSpeechDuration * 2),
  );

  emit({ type: "stage", stage: "transcribing" });

  let idx = 0;
  let empty = 0;
  let speech = 0;
  /*
   * 나온 글자 수를 센다. **이것이 "이 모델이 모르는 말인가" 를 짚는 재료다.**
   *
   * 빈 조각만 세는 것으로는 모자라다. 이 모델은 모르는 말을 들으면 빈 글이
   * 아니라 `"Mm-hmm."` 같은 짧은 로마자를 내놓는 일이 잦다 (직접 확인했다).
   * 그건 "비어 있다" 로 안 잡히므로 **밀도**로 잡는다 — 영어는 초당 20자쯤
   * 나오는데 그 경우는 2자 남짓이었다.
   */
  let chars = 0;
  let processed = 0;
  let lastProgressAt = 0;

  /** 조각 하나를 디코딩해 부모에게 보낸다. */
  const handleSegment = (seg) => {
    const start = seg.start / sampleRate;
    const dur = seg.samples.length / sampleRate;

    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: seg.samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);

    const text = (result.text ?? "").trim();
    if (!text) empty++;
    speech += dur;
    chars += text.length;

    /*
     * 조각 안의 시각은 조각 기준이다. 전체 기준으로 옮겨 앉힌다.
     *
     * 시각을 안 주는 모델이면 여기서 빈 배열이 온다 (`extractWords`).
     * 억지로 채우지 않는다 — 전부 0초가 붙은 낱말은 없는 것보다 나쁘다.
     */
    const words = extractWords(SPEC, result).map((w) => ({
      w: w.w,
      t: Number((start + w.t).toFixed(3)),
    }));

    emit({
      type: "segment",
      idx: idx++,
      start: Number(start.toFixed(3)),
      end: Number((start + dur).toFixed(3)),
      text,
      words,
    });

    processed = start + dur;
    /*
     * 진행률은 조각마다 보내되 너무 잦으면 줄인다.
     *
     * 조각 하나에 3초쯤 걸리니 사실 잦지 않지만, 짧은 조각이 이어지는 구간
     * (한 마디씩 끊어 말하는 회의)에서는 초당 수십 줄이 된다. 부모가 그때마다
     * DB 를 쓰면 조각 INSERT 와 부딪힌다.
     */
    if (Date.now() - lastProgressAt > 1000) {
      lastProgressAt = Date.now();
      emit({ type: "progress", processed: Number(processed.toFixed(2)) });
    }
  };

  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      handleSegment(seg);
    }
  };

  const samples = wave.samples;
  for (let i = 0; i < samples.length; i += windowSize) {
    vad.acceptWaveform(samples.subarray(i, i + windowSize));
    // **밀어 넣는 족족 빼낸다.** 안 빼면 원형 버퍼가 넘쳐 조각이 사라진다.
    drain();
  }
  // 마지막 말이 침묵으로 끝나지 않았으면 아직 버퍼에 남아 있다.
  vad.flush();
  drain();

  emit({
    type: "progress",
    processed: Number(processed.toFixed(2)),
  });
  emit({
    type: "done",
    segments: idx,
    empty,
    chars,
    speech: Number(speech.toFixed(2)),
  });
  log(
    `끝. 조각 ${idx}개 (빈 것 ${empty}개), 말한 시간 ${speech.toFixed(1)}초, ` +
      `글자 ${chars}자, 총 ${((Date.now() - t0) / 1000).toFixed(1)}초`,
  );
}

/*
 * 직접 돌렸을 때만 시작한다.
 *
 * `groupWords()` 하나만 꺼내 시험해 보는 쪽이 있어서, 껍데기에서 곧바로 도는
 * 코드를 두지 않는다. 이 갈림길이 없으면 import 하는 순간 인자 검사가 먼저
 * 돌아 "인자가 없다" 로 죽는다.
 */
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    fail(e instanceof Error ? e.message : String(e));
  });
}
