#!/usr/bin/env node
/**
 * 화자 분리 워커. **독립 프로그램이다 — 앱과 같은 프로세스에서 절대 돌리지 마라.**
 *
 * 소리를 들어 "여기서 여기까지는 같은 사람" 을 가른다. 이름은 안 붙인다 —
 * 번호만 붙인 구간 목록을 낸다. 그 번호에 이름을 다는 것은 에이전트의 몫이고,
 * 낱말에 붙이는 것은 부모의 몫이다. 여기는 **소리** 까지만이다.
 *
 * ## 왜 자식 프로세스인가 — 죽는 법이 둘이다
 *
 * 1. `sherpa-onnx-node` 의 오류는 C++ 의 `Ort::Exception` 이고, N-API 를 넘으며
 *    `std::terminate()` 를 부른다. `try/catch` 로도 `uncaughtException` 으로도
 *    **안 잡힌다.** 프로세스가 종료 코드 134(SIGABRT)로 그냥 죽는다.
 * 2. **cgroup 이 메모리로 죽이면 SIGKILL(137) 이다.** 그때는 JS 오류도, 마지막
 *    출력 한 줄도 없다. 워커가 그것을 막을 길은 없다.
 *
 * 둘 다 워커가 제 안에서 처리할 수 없는 죽음이다. 그래서 여기서 하는 일은
 * **부모가 알아볼 수 있게 죽는 것** 뿐이다:
 *
 * - `meta` 를 가장 먼저 내보낸다. 길이를 알면 부모는 이 판이 몇 MB 짜리였는지
 *   뒤에서 셈할 수 있다 (아래 메모리 식). 종료 코드만 남은 자리에 근거가 생긴다.
 * - **길이 상한을 미리 막는다.** 상한을 넘는 파일은 돌려 보지도 않고
 *   사람이 읽을 수 있는 문장으로 거절한다. OOM 으로 죽으면 아무 말도 못 남긴다.
 * - **`turns` 를 실루엣보다 **먼저** 내보낸다.** 뒤 단계(임베딩)가 죽어도 부모는
 *   이미 구간 목록을 쥐고 있다. 전사문이 화자 분리보다 먼저인 것과 같은 규율이다.
 *   실제로 그렇게 된다 — 99분짜리를 `-m 1g` 에 넣어 보니 분리는 끝났고(구간 1,019개,
 *   그 줄 34KB 가 온전히 나왔다) **임베딩 단계에서 SIGKILL(137)** 이 왔다. 부모가 본
 *   것은 `meta` · `stage segmenting` · `turns` · `stage embedding` 넷과 종료 코드
 *   137 이다. `done` 이 없으면 신뢰도가 없는 것이지 분리가 실패한 것이 아니다.
 * - `process.exit()` 로 끝내지 않는다. POSIX 에서 stdout 이 **파이프면 쓰기가
 *   비동기**라, 마지막 줄(특히 `error`)을 쓰자마자 exit 하면 그 줄이 사라진다.
 *   여기서는 종료 코드만 정해 두고 이벤트 루프가 마르며 저절로 끝나게 둔다.
 *
 * ## 부모와 이야기하는 법
 *
 * stdout 에 JSON 을 **한 줄에 하나씩**. stderr 는 사람이 읽는 로그다.
 *
 *   {"type":"meta","duration":1286.1,"sampleRate":16000}
 *   {"type":"stage","stage":"segmenting"|"embedding"|"clustering"}
 *   {"type":"turns","speakers":5,"requested":5,"segments":[{"s":0.689,"e":6.089,"k":0}, …]}
 *   {"type":"silhouette","values":[{"s":0.689,"e":6.089,"k":0,"sil":0.615}, …]}
 *   {"type":"done","msProcess":332000,"peakMb":338}
 *   {"type":"error","message":"…"}
 *
 * **진행률이 없다.** `process(samples)` 가 전부를 한 번에 돌려주기 때문이다 —
 * 그 안에서 분할·임베딩·군집이 다 일어나지만 중간 산출이 하나도 안 나온다.
 * 막대를 만들 수 없으니 단계 이름만 세 번 말한다. 그 이름이 실제로 덮는 구간은
 * 이렇다 (화면에 보일 말과 안에서 도는 일이 딱 맞지는 않는다는 뜻이다):
 *
 *   segmenting — `sd.process()` 한 번. 시간의 대부분이 여기다 (RTF 0.12~0.28).
 *   embedding  — 실루엣을 내려고 구간마다 임베딩을 **다시** 뽑는 두 번째 훑기.
 *   clustering — 그 벡터로 중심과 실루엣을 세는 셈. 눈 깜짝할 새다.
 *
 * ## 성질은 **인자로 온다**
 *
 * 모델 파일 이름도, `windowShiftRatio` 도, 길이 상한도 여기 박혀 있지 않다.
 * 부모가 서술자에서 골라 `--spec` 에 JSON 으로 실어 준다 (`transcribe.mjs` 와 같다).
 *
 * 워커가 제 손으로 표를 읽게 하지 않는 이유: 환경변수가 어긋난 날(부모는 새 모델,
 * 워커는 기본값) 둘이 다른 설정으로 도는데 그 어긋남이 아무 데도 안 보인다.
 * 나오는 것은 그냥 이상한 화자 구분이다. 부모가 고르고 워커가 따르면 그 갈림길이 없다.
 *
 * 받는 서술자 모양 (`src/lib/diar-models.ts` 의 `DiarRuntimeSpec` 그대로):
 *
 *   {
 *     "id": "pyannote3-campplus",
 *     "sampleRate": 16000,
 *     "defaultThreads": 4,
 *     "windowShiftRatio": 0.1,
 *     "minDurationOn": 0.3,
 *     "minDurationOff": 0.5,
 *     "clusterMargin": 2,        // 부모가 k 를 셀 때 쓴다. 워커는 안 본다.
 *     "maxAudioSeconds": 10800
 *   }
 *
 * **모델 파일의 자리는 서술자에 없다.** `--seg`·`--emb` 로 온다 (부모의
 * `diarPaths.seg`·`diarPaths.emb` — 서술자가 정한 이름을 그 자리에 이어 만든 값).
 * 갈라 둔 이유는 `env.ts` 의 `DIAR_MODEL_DIR` 설명에 있다: 분리 모델이 어느 칸에
 * 앉을지는 배포가 정한다 — 전사 모델 자리에서 짐작할 일이 아니다. (손으로 돌릴 때는 서술자에
 * `files: {segmentation, embedding}` 을 적고 `--model-dir` 을 줘도 된다.)
 *
 * ## 왜 이 값들인가 — 앞선 네 판이 uno 에서 실측한 것이다. 여기서 다시 정하지 않는다.
 *
 * - **`windowShiftRatio` 0.1.** 0.25 는 60분 이상 네 편에서 **0/4** 로 무너졌다.
 *   DER 이 서서히 나빠지는 게 아니라 **3~4% 아니면 20~25%** 둘 중 하나다.
 *   그래서 이 워커는 0.1 보다 큰 값을 **거절한다** (`readSpec`). 절벽 앞에서는
 *   "조심하자" 가 아니라 지나갈 수 없게 막는 편이 낫다.
 * - **`minDurationOn` 0.3 · `minDurationOff` 0.5.**
 * - **군집 수는 반드시 받는다 (`--clusters`).** 안 주면 진짜 회의에서 화자가
 *   40~134명 나온다. 그 수를 정하는 법(목록 인원 + 2)은 **부모의 몫이다** —
 *   워커는 받은 수를 그대로 쓴다. k=L 을 주면 AMI 에서 −7.0pt·DER +8.6pt 이고,
 *   사용자 녹음 한 편(21분 26초, 3명)에서도 k=3 이 셋째 사람의 낱말 197개를
 *   **197개 전부** 둘째 사람에게 붙였다. 값은 거의 공짜다 (k 3→5 에 RSS 338→347MB).
 * - **메모리는 길이에 선형이다: 10.5MB/분 + 114MB** (군집 수를 줄 때).
 *   60분 705MB · 90분 1,037MB · 120분 1,413MB — 전부 실측. 그래서 상한 180분.
 *   (분당 39MB 는 군집 수를 **안 줬을 때**의 값이다. 그 길은 안 쓴다.)
 *
 *   **다만 이 워커의 봉우리는 그보다 크다. 아래 값을 믿어라.**
 *   위 식은 분리만 돌린 프로세스의 끝 RSS 이고, 여기서는 같은 프로세스에서
 *   실루엣용 임베딩을 **한 번 더** 뽑는다. uno 에서 `VmHWM`(진짜 봉우리)으로 잰 값:
 *
 *     길이      실루엣까지   분리만
 *     1.0분      231MB        —
 *     15.7분     469MB       298MB
 *     49.3분     870MB       529MB
 *
 *   긴 두 점을 잇는 선이 **약 11.9MB/분 + 281MB** 이고, 180분이면 **2.4GB** 다 —
 *   서술자의 예산(`memory.budgetMb`)과 길이 상한을 정하는 사람은 이 값으로 셈해라.
 *   실루엣이 더하는 몫은 15.7분에 +171MB · 49.3분에 +341MB 이고, 분리 객체를 놓고
 *   `gc()` 를 불러 봐도 봉우리는 그대로였다(471MB) — **줄일 길이 없다.**
 * - **시간**: 21분26초 녹음에 332~356초 (RTF 0.26~0.28, 기계가 붐빌 때).
 *   한가한 uno 에서 스레드 4로 다시 재면 RTF 0.12 다 (15.7분에 114초 · 49.3분에 364초).
 *   실루엣 훑기는 그 위에 9%쯤 얹는다 (15.7분에 9.7초 · 49.3분에 37초).
 *
 * ## 실루엣을 왜 워커가 내는가
 *
 * sherpa master 의 `FastClusteringConfig.compute_confidence` (실루엣 기반)는
 * **Node 바인딩에 안 뚫려 있다** (우리가 쓰는 1.13.7 의 types.js 에 0회).
 * 그런데 `SpeakerEmbeddingExtractor` 는 그대로 열려 있다. 그래서 같은 임베딩
 * 모델로 구간마다 벡터를 **한 번 더** 뽑아 우리가 같은 값을 센다. 분할 모델은
 * 다시 안 돌린다.
 *
 * 이 값 하나로 두 가지를 한다. 둘 다 **단정하지 않는 쪽으로만** 쓴다:
 *
 * - **낱말 단위** — AUC 0.801 이지만 딴 파일에서 고른 문턱으로 정밀도 79.0% ·
 *   재현율 6.9%(표시 2.3%)다. "틀렸다" 가 아니라 **"덜 확실하다"** 까지만이다.
 *   "이 줄은 누구의 말로도 돌리지 마라" 로 쓰면 절반이 멀쩡한 줄이다.
 * - **파일 단위** — 구간 실루엣 **중앙값 ≤ 0.2~0.25 면 이 녹음을 의심하라**
 *   (정확도와 Spearman 0.72~0.97). 원래 쓰려던 `나온 수 < 요청한 수` 는
 *   AMI 9편에서 **0번** 울렸다 — 그 신호는 쓰지 마라.
 *
 * 실행:
 *   node scripts/diarize.mjs --wav <16k 모노 WAV> --spec '<서술자 JSON>' \
 *        --clusters N --seg <분할 .onnx> --emb <임베딩 .onnx> \
 *        [--threads 4] [--no-silhouette]
 *
 *   손으로 돌릴 때: --spec 대신 --model <id> (옆의 diar-models.json 을 읽는다),
 *   파일은 --seg/--emb 또는 서술자의 files + --model-dir.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
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
 * `console.log` 도 결국 같은 곳으로 가지만, 여기서 나가는 것은 사람이 읽는 글이
 * 아니라 부모가 파싱하는 자료다. 다른 무엇도 stdout 으로 나가면 안 된다는 뜻을
 * 코드 모양으로 남겨 둔다 — 진단은 전부 `log()` 로 stderr 에 쓴다.
 */
function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.error("[diarize]", ...args);
}

/**
 * 그만둔다는 신호. **`process.exit()` 을 쓰지 않는 이유가 있다.**
 *
 * POSIX 에서 stdout 이 파이프면 쓰기가 비동기다. `error` 줄을 쓰자마자 exit 하면
 * 그 줄이 부모에게 닿기 전에 사라진다 — 부모는 종료 코드 1만 보고 "왜" 를 모르고,
 * 그건 이 워커가 하지 말아야 할 유일한 실패다(어차피 못 막는 죽음이 둘이나 있다).
 * 그래서 여기서는 던지기만 하고, 맨 아래에서 종료 코드만 정한 뒤 이벤트 루프가
 * 마르며 저절로 끝나게 둔다. 그때 stdout 은 반드시 비워진다.
 */
class Abort extends Error {}

function fail(message) {
  emit({ type: "error", message: String(message).slice(0, 2000) });
  throw new Abort(String(message));
}

// ─────────────────────────────────────────────────────────────
//   인자와 서술자
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
 * 어림 메모리의 기본값. **거절 문장과 로그에만 쓴다** — 막는 것은 길이 상한이지
 * 이 셈이 아니다.
 *
 * 서술자의 `memory` 칸은 모델 칸에 있고 워커에게 오는 `runtime` 에는 안 실린다
 * (예산 검사는 뜰 때 부모가 한다 — `assertDiarModel`). 그래서 여기 실측 기본값을
 * 두고, 부모가 `memBaseMb`·`memPerMinuteMb` 를 실어 보내면 그쪽이 이긴다.
 *
 * 이 값은 **분리만** 돌렸을 때의 것이다. 실루엣까지 하는 이 워커의 진짜 봉우리는
 * 더 크다 — 맨 위 메모리 표를 보라.
 */
const MEM_BASE_MB = 114;
const MEM_PER_MINUTE_MB = 10.5;

/** 이 워커가 지나가게 두는 가장 큰 `windowShiftRatio`. 아래 `readSpec` 의 주석을 보라. */
const MAX_WINDOW_SHIFT_RATIO = 0.1;

/**
 * 서술자를 손에 쥔다. `--spec` 이 먼저고, 없으면 `--model` 로 표에서 찾는다.
 *
 * **아는 모양만 받는다.** 부모가 보낸 것이라 믿어도 될 것 같지만, 여기서 안 보면
 * 잘못된 값이 sherpa 까지 내려가고 거기서 나는 오류는 C++ 예외라 프로세스를 통째로
 * 죽인다 (그게 이 워커가 자식 프로세스인 이유다). 여기서 걸러 내면 사람이 읽을 수
 * 있는 문장 하나로 끝난다.
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
    const table = join(fileURLToPath(new URL(".", import.meta.url)), "diar-models.json");
    if (!existsSync(table)) {
      fail(`--model 로 찾을 표(${table})가 없습니다. --spec 으로 서술자를 직접 넘기세요.`);
    }
    const parsed = JSON.parse(readFileSync(table, "utf8"));
    const found = parsed.models?.[args.model];
    if (!found) {
      fail(
        `모르는 모델 id 입니다: ${args.model}. ` +
          `아는 것: ${Object.keys(parsed.models ?? {}).join(", ")}`,
      );
    }
    spec = found.runtime ?? found;
  } else {
    fail("--spec (또는 손으로 돌릴 때 --model) 이 필요합니다");
  }

  if (spec.sampleRate !== 16000) {
    /*
     * 분할 모델도 임베딩 모델도 16kHz 로 내보내진 것이다. 다른 표본율을 주면
     * sherpa 가 C++ 쪽에서 거절하고, 그 거절은 잡을 수 없다. 앞 단계(ffmpeg)가
     * 늘 16k 로 맞추므로 여기 걸리면 그건 우리 쪽 실수라는 뜻이다.
     */
    fail(`서술자의 sampleRate 가 ${spec.sampleRate} 입니다. 이 모델들은 16000 만 받습니다.`);
  }

  /*
   * **이 검사가 이 파일에서 가장 중요한 검사다.**
   *
   * `windowShiftRatio` 0.25 는 60분 이상 네 편에서 **0/4** 로 무너졌다 —
   * DER 이 서서히 나빠지는 게 아니라 3~4% 아니면 20~25% 둘 중 하나다. 그 절벽은
   * 결과만 보고는 안 보인다 (오류도 경고도 없이 그냥 엉뚱한 화자 구분이 나온다).
   * 그러니 "0.1 을 쓰자" 가 아니라 **더 큰 값이 지나갈 수 없게** 막는다.
   * 나중에 다시 재 보고 싶으면 이 상수를 고치면서 근거를 함께 적어라.
   */
  const shift = spec.windowShiftRatio;
  if (!(shift > 0) || shift > MAX_WINDOW_SHIFT_RATIO) {
    fail(
      `서술자의 windowShiftRatio 가 ${shift} 입니다. ` +
        `${MAX_WINDOW_SHIFT_RATIO} 이하여야 합니다 — 0.25 는 60분 이상 네 편에서 ` +
        `0/4 로 무너졌습니다(DER 20~25%). 오류 없이 조용히 틀리는 값입니다.`,
    );
  }
  if (!(spec.minDurationOn >= 0) || !(spec.minDurationOff >= 0)) {
    fail("서술자에 minDurationOn · minDurationOff 가 있어야 합니다 (실측값 0.3 · 0.5)");
  }
  if (!(spec.maxAudioSeconds > 0)) {
    /*
     * 상한이 없으면 긴 파일이 OOM 으로 죽는다. 그 죽음은 SIGKILL 이라 **아무 말도
     * 못 남긴다** — 부모가 볼 수 있는 것은 종료 코드 137 뿐이다. 서술자가 상한을
     * 말하게 해서, 거절을 문장으로 할 수 있는 자리를 만든다.
     */
    fail(
      "서술자에 maxAudioSeconds 가 있어야 합니다. " +
        "메모리가 길이에 선형(10.5MB/분 + 114MB)이라 상한 없이 돌리면 긴 파일이 " +
        "말없이 SIGKILL 로 죽습니다 (실측 상한 180분).",
    );
  }
  return spec;
}

function readArgs() {
  const args = parseArgs(process.argv.slice(2));
  const wav = args.wav;
  if (!wav) fail("--wav 가 필요합니다 (16kHz 모노 WAV)");

  const spec = readSpec(args);

  /*
   * **군집 수는 반드시 온다.** 안 주고 문턱(threshold)에 맡기면 진짜 회의에서
   * 화자가 40~134명 나온다. 그 수를 어떻게 정하는지(목록 인원 + 2)는 부모가 알고,
   * 워커는 받은 수를 그대로 쓴다 — 여기서 더하거나 빼면 두 곳이 같은 것을 정하게 된다.
   */
  const clusters = Number(args.clusters);
  if (!Number.isInteger(clusters) || clusters < 1 || clusters > 100) {
    fail(
      `--clusters 는 1 이상 100 이하의 정수여야 합니다 (받은 것: ${args.clusters}). ` +
        `군집 수를 안 주면 진짜 회의에서 화자가 40~134명 나옵니다.`,
    );
  }

  /*
   * 모델 파일의 **자리는 인자로 온다.** 서술자에는 없다.
   *
   * 부모가 `diarPaths.seg`·`diarPaths.emb` 를 그대로 넘긴다 — 그 값은 서술자가
   * 정한 **이름**을 배포가 정한 **자리**에 이어 만든 것이다(`src/lib/env.ts`).
   * 분리 모델이 어느 칸에 앉는지는 배포마다 다르고(우리가 받은 볼륨 · 스택이
   * 읽기 전용으로 물려 준 자리), 그것을 전사 모델 자리에서 짐작하면 읽기 전용
   * 자리에 쓰다 EROFS 로 죽는다. 그래서 짐작하지 않고 받는다.
   *
   * 손으로 돌릴 때만 다른 길이 하나 더 있다: 서술자에 `files` 를 적고
   * `--model-dir` 로 폴더를 주는 길(전사 워커와 같은 모양).
   */
  const dir = args["model-dir"];
  const f = spec.files ?? {};
  const at = (name) => (dir ? join(dir, name) : name);
  const segmentation = args.seg ?? (f.segmentation ? at(f.segmentation) : null);
  const embedding = args.emb ?? (f.embedding ? at(f.embedding) : null);
  if (!segmentation || !embedding) {
    fail(
      "분할·임베딩 모델 파일이 필요합니다: --seg <분할 .onnx> --emb <임베딩 .onnx> " +
        "(또는 서술자의 files.segmentation·files.embedding 과 --model-dir).",
    );
  }

  return {
    wav,
    spec,
    clusters,
    // 스레드도 서술자에 기본값이 있다. 인자가 오면 그쪽이 이긴다.
    // 4가 좋다는 것은 전사 워커에서 실측한 값이다(물리 4코어에 논리 8, 8은 2보다 느리다).
    threads: Number(args.threads ?? spec.defaultThreads ?? 4) || 4,
    // 실루엣은 임베딩을 한 번 더 뽑는 값이다. 재는 판에서 시간을 아끼고 싶을 때만 끈다.
    silhouette: args["no-silhouette"] !== "true",
    model: { segmentation, embedding },
  };
}

// ─────────────────────────────────────────────────────────────
//   메모리 — 봉우리를 재고, 넘을 것 같으면 미리 거절한다
// ─────────────────────────────────────────────────────────────

/**
 * `VmHWM` = 이 프로세스가 여태 쓴 상주 메모리의 **최고치**. 끝에서 읽으면 그 판의
 * 봉우리다. `process.memoryUsage().rss` 는 읽는 그 순간의 값이라 봉우리를 놓친다
 * (sherpa 가 쥐었다 놓은 것은 이미 돌려준 뒤다).
 *
 * 리눅스가 아니면(개발 기계) 그런 파일이 없다. 그때는 지금의 rss 로 갈음한다 —
 * 봉우리가 아니라 마지막 값이지만, 그 길로 가는 것은 사람이 손으로 돌려 보는 때뿐이다.
 */
function peakMb() {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {
    /* 리눅스가 아니다 */
  }
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

/** 이 길이면 몇 MB 쯤 쓰는가 — 실측한 선형식. 거절 문장과 사후 판단에 쓴다. */
function estimateMb(spec, seconds) {
  const base = spec.memBaseMb ?? MEM_BASE_MB;
  const per = spec.memPerMinuteMb ?? MEM_PER_MINUTE_MB;
  return Math.round(base + (per * seconds) / 60);
}

function tooLong(spec, seconds) {
  const cap = spec.maxAudioSeconds;
  return (
    `녹음이 ${(seconds / 60).toFixed(1)}분입니다. 화자 분리는 ${(cap / 60).toFixed(0)}분까지만 합니다 — ` +
    `메모리가 길이에 선형이라(10.5MB/분 + 114MB) 이 길이면 ${estimateMb(spec, seconds)}MB 를 쓰고, ` +
    `그만큼을 못 받으면 아무 말도 못 남기고 죽습니다. 전사문은 그대로 남습니다.`
  );
}

// ─────────────────────────────────────────────────────────────
//   실루엣 — 임베딩을 한 번 더 뽑아 우리가 센다
// ─────────────────────────────────────────────────────────────

/**
 * 코사인 비유사도. 중심 `c` 는 정규화하지 않은 **합** 이어도 된다 — 여기서
 * 길이로 나누므로 크기는 셈에 안 들어온다. (그래서 아래에서 중심을 만들 때
 * 개수로 나누는 단계가 없다.)
 */
function cosDist(u, c) {
  let dot = 0;
  let n = 0;
  for (let d = 0; d < u.length; d++) {
    dot += u[d] * c[d];
    n += c[d] * c[d];
  }
  n = Math.sqrt(n) || 1;
  return 1 - dot / n;
}

/**
 * 구간마다 화자 임베딩을 뽑는다. 벡터는 **L2 정규화**한다 — sherpa 의 군집도
 * 정규화한 뒤 코사인 비유사도를 쓰므로, 같은 자리에서 재야 같은 값이 나온다.
 *
 * 0.2초 미만인 구간은 건너뛴다(`null`). 그만한 소리에서 뽑은 화자 벡터는 뜻이 없다.
 */
function embedSegments(sherpa, wave, segments, embeddingModel, threads) {
  const sr = wave.sampleRate;
  const ex = new sherpa.SpeakerEmbeddingExtractor({
    model: embeddingModel,
    numThreads: threads,
    debug: 0,
    provider: "cpu",
  });

  const vecs = [];
  for (const s of segments) {
    const a = Math.max(0, Math.round(s.s * sr));
    const b = Math.min(wave.samples.length, Math.round(s.e * sr));
    if (b - a < sr * 0.2) {
      vecs.push(null); // 0.2초 미만은 임베딩이 뜻이 없다
      continue;
    }
    const st = ex.createStream();
    st.acceptWaveform({ sampleRate: sr, samples: wave.samples.subarray(a, b) });
    st.inputFinished();
    const v = ex.compute(st);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const u = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) u[i] = v[i] / n;
    vecs.push(u);
  }
  return vecs;
}

/**
 * 구간마다 실루엣 계수. **앞 판(`scratchpad/assign/worker-embed.mjs`)의 셈을 그대로 옮긴 것이다.**
 * 여기서 다시 발명하면 앞 판이 잰 문턱(낱말 0.2 · 파일 중앙값 0.2~0.25)이 뜻을 잃는다.
 *
 *   a = 제 군집 중심까지의 거리 (**자기를 뺀** 중심 — leave-one-out)
 *   b = 가장 가까운 **다른** 군집 중심까지의 거리
 *   sil = (b − a) / max(a, b)
 *
 * 값이 없는 구간이 셋 있다: 0.2초 미만(위에서 벡터가 없다) · 제 군집에 저 혼자
 * (a 를 못 낸다) · 군집이 하나뿐(b 를 못 낸다). 그런 구간은 `null` 이 아니라
 * **목록에서 빠진다** — 부모는 겹치는 구간에서 값을 찾아 쓰므로 없는 값은 없는
 * 채로 두는 편이 낫고, 앞 판의 중앙값도 값이 있는 구간만으로 냈다.
 */
export function scoreSilhouettes(segments, vecs) {
  // 군집별 합. 중심은 이 합을 그대로 쓴다 (위 `cosDist` 가 길이로 나눈다).
  const dim = vecs.find((v) => v)?.length ?? 0;
  const sums = new Map();
  const counts = new Map();
  segments.forEach((s, i) => {
    if (!vecs[i]) return;
    if (!sums.has(s.k)) {
      sums.set(s.k, new Float64Array(dim));
      counts.set(s.k, 0);
    }
    const acc = sums.get(s.k);
    for (let d = 0; d < dim; d++) acc[d] += vecs[i][d];
    counts.set(s.k, counts.get(s.k) + 1);
  });

  const out = [];
  segments.forEach((s, i) => {
    if (!vecs[i]) return;
    const own = sums.get(s.k);
    const k = counts.get(s.k);
    if (!(k > 1)) return; // 제 군집에 저 혼자면 자기를 뺀 중심이 없다
    const c = new Float64Array(dim);
    for (let d = 0; d < dim; d++) c[d] = own[d] - vecs[i][d];
    const a = cosDist(vecs[i], c);

    let b = Infinity;
    for (const [spk, acc] of sums) {
      if (spk === s.k) continue;
      const dd = cosDist(vecs[i], acc);
      if (dd < b) b = dd;
    }
    if (!Number.isFinite(b)) return; // 군집이 하나뿐이다

    out.push({ s: s.s, e: s.e, k: s.k, sil: Number(((b - a) / Math.max(a, b)).toFixed(4)) });
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
//   본체
// ─────────────────────────────────────────────────────────────

async function main() {
  const cfg = readArgs();
  const SPEC = cfg.spec;

  if (!existsSync(cfg.wav)) fail(`WAV 가 없습니다: ${cfg.wav}`);
  for (const [name, path] of Object.entries(cfg.model)) {
    if (!existsSync(path)) {
      fail(
        `모델 파일이 없습니다: ${path} (${name}). ` +
          `\`npm run model:fetch\` 로 볼륨에 내려받으세요.`,
      );
    }
  }

  /*
   * **길이 상한을 WAV 를 읽기 전에 한 번 본다.**
   *
   * 16k 모노 16비트면 초당 32,000바이트다. 파일 크기만으로 길이를 어림할 수 있고,
   * 그 어림이 상한을 넘으면 읽지도 않고 거절한다. 왜 굳이: 180분짜리 WAV 를 통째로
   * 읽으면 그것만으로 Float32 691MB 다. 거절할 파일 때문에 그 메모리를 먼저 쥐면
   * 거절 문장을 내놓기 전에 OOM 으로 죽을 수 있다.
   * (정확한 판단은 아래에서 실제 표본 수로 한 번 더 한다.)
   */
  const roughSeconds = Math.max(0, statSync(cfg.wav).size - 44) / (SPEC.sampleRate * 2);
  if (roughSeconds > SPEC.maxAudioSeconds) fail(tooLong(SPEC, roughSeconds));

  let sherpa;
  try {
    sherpa = require("sherpa-onnx-node");
  } catch (e) {
    fail(
      `sherpa-onnx-node 를 불러오지 못했습니다: ${e.message}. ` +
        `\`npm run asr:install\` (= npm --prefix scripts install) 을 돌렸는지 확인하세요.`,
    );
  }

  const t0 = Date.now();
  let wave;
  try {
    wave = sherpa.readWave(cfg.wav);
  } catch (e) {
    // `readWave` 는 RIFF WAV PCM 만 읽는다. 이 실패는 JS 쪽(TypeError)이라 잡힌다.
    fail(`WAV 를 읽지 못했습니다: ${e.message}`);
  }
  if (wave.sampleRate !== SPEC.sampleRate) {
    fail(
      `WAV 가 ${wave.sampleRate}Hz 입니다. ${SPEC.sampleRate}Hz 여야 합니다 — ` +
        `앞 단계의 ffmpeg 인자(-ar ${SPEC.sampleRate} -ac 1)가 빠졌거나 다른 파일을 읽었습니다.`,
    );
  }

  const duration = wave.samples.length / wave.sampleRate;
  emit({ type: "meta", duration: Number(duration.toFixed(3)), sampleRate: wave.sampleRate });
  if (duration > SPEC.maxAudioSeconds) fail(tooLong(SPEC, duration));
  log(
    `오디오 ${duration.toFixed(1)}초 @ ${wave.sampleRate}Hz, k=${cfg.clusters}, ` +
      `threads=${cfg.threads}, 어림 메모리 ${estimateMb(SPEC, duration)}MB`,
  );

  /*
   * 군집은 **수로만** 준다 (`threshold` 는 0). 문턱에 맡기는 길은 안 쓴다 —
   * 진짜 회의에서 화자가 40~134명 나왔고, 메모리도 분당 39MB 로 는다(수를 주면 10.5MB).
   */
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: cfg.model.segmentation, windowShiftRatio: SPEC.windowShiftRatio },
      numThreads: cfg.threads,
      debug: 0,
      provider: "cpu",
    },
    embedding: {
      model: cfg.model.embedding,
      numThreads: cfg.threads,
      debug: 0,
      provider: "cpu",
    },
    clustering: { numClusters: cfg.clusters, threshold: 0 },
    minDurationOn: SPEC.minDurationOn,
    minDurationOff: SPEC.minDurationOff,
  });
  if (sd.sampleRate !== wave.sampleRate) {
    fail(`모델이 ${sd.sampleRate}Hz 를 바랍니다. 오디오는 ${wave.sampleRate}Hz 입니다.`);
  }
  log(`모델 적재 ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  /*
   * 여기서부터가 이 워커의 전부다. **한 번에 다 돌려준다** — 중간 산출이 없고,
   * 죽으면(OOM·Ort::Exception) 여기서 죽는다. 부모는 종료 코드로만 안다.
   */
  emit({ type: "stage", stage: "segmenting" });
  const tProc = Date.now();
  const raw = sd.process(wave.samples);
  const msProcess = Date.now() - tProc;

  /*
   * 시작 시각으로 줄 세운다. sherpa 는 화자별로 모아 주므로 시간 순서가 아니다.
   * 부모는 낱말을 시간 순으로 훑으며 붙이니 여기서 세워 두는 편이 낫다
   * (정확도와는 무관하다 — 같은 구간 집합이다).
   */
  const segments = raw
    .map((s) => ({ s: Number(s.start.toFixed(3)), e: Number(s.end.toFixed(3)), k: s.speaker }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const speakers = new Set(segments.map((x) => x.k)).size;

  /*
   * **실루엣보다 먼저 내보낸다.** 뒤 단계가 죽어도 부모는 구간 목록을 쥔다.
   * 신뢰도는 없으면 없는 대로 쓸 수 있지만, 구간이 없으면 아무것도 못 한다.
   */
  emit({ type: "turns", speakers, requested: cfg.clusters, segments });
  log(
    `분리 ${(msProcess / 1000).toFixed(1)}초 (RTF ${(msProcess / 1000 / duration).toFixed(3)}), ` +
      `구간 ${segments.length}개 · 군집 ${speakers}/${cfg.clusters}개`,
  );

  let values = [];
  if (cfg.silhouette) {
    /*
     * JS 오류로 실루엣이 엎어져도 화자 분리 자체는 이미 성공했다. 그때는 빈 목록을
     * 내고 계속 간다 — 부모는 "신뢰도 없음" 으로 읽고(표시도 파일 경고도 안 하고)
     * 구간은 그대로 쓴다. 조용히 넘기지는 않는다: stderr 에 왜 없는지 남긴다.
     */
    try {
      emit({ type: "stage", stage: "embedding" });
      const tEmb = Date.now();
      const vecs = embedSegments(sherpa, wave, segments, cfg.model.embedding, cfg.threads);
      /*
       * 마지막 단계 이름. **군집을 다시 하지는 않는다** — 위 `process()` 가 이미 끝냈다.
       * 여기서 하는 것은 그 군집을 재는 일(중심과 실루엣)이고, 화면에 보일 말로는
       * 그것이 "clustering" 이다. 눈 깜짝할 새라 사실상 끝났다는 신호에 가깝다.
       */
      emit({ type: "stage", stage: "clustering" });
      values = scoreSilhouettes(segments, vecs);
      const sorted = values.map((v) => v.sil).sort((a, b) => a - b);
      const median = sorted.length ? sorted[sorted.length >> 1] : null;
      log(
        `실루엣 ${values.length}/${segments.length}개, 중앙값 ${median === null ? "—" : median.toFixed(3)}` +
          `${median !== null && median <= 0.25 ? " (≤0.25 — 이 녹음은 의심스럽다)" : ""}, ` +
          `${((Date.now() - tEmb) / 1000).toFixed(1)}초`,
      );
    } catch (e) {
      log(`실루엣을 못 냈습니다 (구간은 그대로 씁니다): ${e instanceof Error ? e.message : e}`);
      values = [];
    }
  } else {
    log("실루엣은 끄고 돌렸습니다 (--no-silhouette)");
  }
  emit({ type: "silhouette", values });

  const peak = peakMb();
  emit({ type: "done", msProcess, peakMb: peak });
  log(
    `끝. 총 ${((Date.now() - t0) / 1000).toFixed(1)}초, 봉우리 ${peak}MB ` +
      `(어림 ${estimateMb(SPEC, duration)}MB)`,
  );
}

/*
 * 직접 돌렸을 때만 시작한다 (전사 워커와 같은 규율 — 함수 하나만 꺼내 시험할 수 있게).
 *
 * 그리고 **여기서도 `process.exit()` 을 부르지 않는다.** 종료 코드만 정해 두면
 * 이벤트 루프가 마르며 프로세스가 끝나고, 그때 stdout 이 반드시 비워진다.
 * 우리가 못 막는 죽음(SIGABRT·SIGKILL)에서 부모가 볼 수 있는 것은 종료 코드뿐이니,
 * 적어도 우리가 아는 실패만큼은 마지막 줄까지 부모에게 닿아야 한다.
 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    if (!(e instanceof Abort)) {
      emit({ type: "error", message: (e instanceof Error ? e.message : String(e)).slice(0, 2000) });
    }
    process.exitCode = 1;
  });
}
