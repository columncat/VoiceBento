import table from "../../scripts/asr-models.json";

/**
 * 전사 모델 서술자 — **모델의 성질을 아는 유일한 자리.**
 *
 * ## 왜 한 곳에 모으는가
 *
 * 이 앱을 처음 지을 때 모델의 성질은 코드 곳곳에 흩어져 있었다. VAD 의
 * 30초는 워커에, 스레드 4는 `env.ts` 에, featureDim 80 은 다시 워커에,
 * "한국어를 못 한다" 는 안내는 `model.ts` 와 화면 컴포넌트에 두 벌,
 * CC-BY 출처는 README 와 화면에 또 두 벌.
 *
 * 그 상태에서 모델을 갈아 끼우면 **한 곳만 고치고 나머지는 옛말이 남는다.**
 * 그중 가장 나쁜 것이 안내 문구다 — 한국어를 알아듣는 모델을 붙여 놓고도
 * 화면에는 "한국어를 못 합니다" 가 계속 떠 있게 되고, 그건 틀린 것을 넘어
 * 사람이 쓸 수 있는 기능을 못 쓰게 만든다.
 *
 * 그래서 사실은 `scripts/asr-models.json` 한 곳에 적고, **문장은 그 사실에서
 * 만든다.** 아래 함수들이 그 만드는 자리다.
 *
 * ## 자료가 왜 `scripts/` 에 있나
 *
 * 런타임 이미지에 통째로 복사되는 것이 `scripts/` 다 (`Dockerfile` 의
 * `COPY --from=builder /app/scripts ./scripts`). `src/` 는 번들로만 들어가고
 * 파일로는 없다. 그래서 워커(`transcribe.mjs`)와 내려받기(`fetch-model.mjs`)가
 * 파일로 읽을 수 있는 자리는 거기뿐이다. 이 모듈은 그 JSON 을 import 해서
 * **타입과 불변식과 문장**을 얹는다.
 *
 * ## 모델을 하나 더 붙이려면
 *
 * 1. `scripts/asr-models.json` 에 서술자 한 칸.
 * 2. `scripts/transcribe.mjs` 의 `RECOGNIZERS` 에 **결과 모양 어댑터** 하나
 *    (파일 구성이 다르면. transducer 와 whisper 는 이미 있다).
 * 3. `ASR_MODEL_ID` 로 고른다.
 *
 * 그게 전부다. 파이프라인·화면·에이전트 프롬프트는 손대지 않는다 — 전부
 * 여기서 읽는다.
 */

// ─────────────────────────────────────────────────────────────
//   모양
// ─────────────────────────────────────────────────────────────

/**
 * 이 모델이 시각을 얼마나 잘게 주는가.
 *
 * - `"word"` — 낱말마다 시각. 낱말을 눌러 그 자리로 뛸 수 있다.
 * - `"token"` — 토큰마다 시각. 워커가 낱말로 묶어 준다 (parakeet 이 이쪽).
 * - `"none"` — **아무것도 안 준다.** sherpa-onnx 의 whisper 가 그렇다
 *   (`result.timestamps` 가 빈 배열이다 — 실측). 그때는 조각의 시작·끝만
 *   남고 화면은 낱말 클릭을 접어야 한다.
 *
 * 이 값이 있어야 화면이 **"낱말 시각이 비어 있다"와 "이 모델은 원래 안
 * 준다"를 가를 수 있다.** 둘을 못 가르면 whisper 를 붙인 날 낱말 클릭이
 * 조용히 아무 데도 안 뛰는 버튼이 된다.
 */
export type TimestampGranularity = "none" | "token" | "word";

/** 파일 구성. 어댑터를 고르는 열쇠이기도 하다. */
export type ModelKind = "transducer" | "whisper";

/**
 * 워커에게 넘기는 조각. **JSON 으로 직렬화해 argv 로 간다.**
 *
 * 워커는 Next 번들 밖의 독립 프로그램이라 이 모듈을 import 하지 못한다
 * (그리고 import 하면 안 된다 — 그 규율은 워커 파일 첫머리에 적혀 있다).
 * 그래서 **부모가 고르고 워커는 따른다.** 워커가 제 손으로 표를 다시 읽으면
 * 환경변수가 어긋난 날 부모와 워커가 다른 모델을 쓰게 되는데, 그 어긋남은
 * 아무 데도 안 보인다.
 *
 * 여기 담기는 것은 전부 공개해도 되는 사실이다 — argv 는 호스트 `ps` 에서
 * 그대로 보이므로 사람이 한 말이나 열쇠는 절대 안 싣는다.
 */
export interface ModelRuntimeSpec {
  id: string;
  kind: ModelKind;
  /** sherpa 의 `modelConfig.modelType`. 비워 두면 ONNX 메타데이터에서 짐작한다. */
  modelType: string;
  files: {
    encoder: string;
    decoder: string;
    /** transducer 만. whisper 에는 없다. */
    joiner?: string;
    tokens: string;
  };
  sampleRate: number;
  featureDim: number;
  defaultThreads: number;
  /**
   * 한 번에 넣을 수 있는 오디오 길이의 상한 (초). 없으면 null.
   *
   * parakeet 은 400 이다 — 내보낸 ONNX 의 상대 위치 임베딩이 5,000프레임에
   * 고정이라 401초에서 죽는다. whisper 는 30초 창으로 도는 모델이라 30 이다.
   * **이 값이 VAD 상한의 근거다** (아래 불변식).
   */
  maxAudioSeconds: number | null;
  timestamps: TimestampGranularity;
  vad: {
    threshold: number;
    minSilenceDuration: number;
    minSpeechDuration: number;
    /** 조각 하나의 상한. `maxAudioSeconds` 보다 반드시 작아야 한다. */
    maxSpeechDuration: number;
    windowSize: number;
  };
}

export interface AsrModel {
  id: string;
  /** 사람이 읽는 이름. 화면에 그대로 적어도 되는 값. */
  name: string;
  /** 받아 풀면 생기는 폴더 이름. 배포 안내에 쓴다. */
  dirName: string;

  runtime: ModelRuntimeSpec;

  /** 시각의 눈금(초). `timestamps === "none"` 이면 null. */
  timestampResolution: number | null;
  /** 실시간 대비 처리 시간. 모르면 null. 기다림을 어림하는 데만 쓴다. */
  rtf: number | null;
  /**
   * 초당 이만큼도 글자가 안 나오면 "알아듣지 못한 것" 으로 본다.
   *
   * **모델마다 다르다.** parakeet 은 영어를 초당 20자쯤 내놓으므로 5가
   * 넉넉한 문턱이지만, 한국어를 하는 모델에 같은 값을 쓰면 멀쩡한 한국어
   * 전사(초당 5~7자)가 통째로 "못 알아들었다" 로 잡힌다.
   */
  minCharsPerSecond: number;
  /**
   * 못 알아듣는 소리에 **빈 글이 아니라 그럴듯한 글을 지어내는가.**
   *
   * 이 한 칸이 에이전트에게 알릴 것 중 가장 중요하다. 아래
   * `modelBrief()` 를 보라.
   */
  hallucinatesOnUnsupported: boolean;

  /** 알아듣는 말 (ISO 639-1). 이 목록에 없으면 못 알아듣는다. */
  languages: string[];
  /** 사람이 읽는 짧은 목록. */
  languagesLabel: string;
  /** 사람이 읽는 긴 목록. */
  languagesLong: string;

  /** 이 모델에만 있는 버릇. `modelBrief()` 가 `notes` 로 넘긴다. */
  agentNotes: string[];

  /** 출처 고지. **장식이 아니라 의무다** (parakeet 가중치가 CC-BY-4.0). */
  attribution: string;
  credit: {
    weights: string;
    weightsLicense: string;
    export: string;
    exportLicense: string;
  };

  /** 자동으로 받을 수 있으면 그 자리. 손으로 넣어야 하면 null. */
  download: {
    archive: { url: string; size: number; sha256: string; unpackedLabel: string };
  } | null;
}

// ─────────────────────────────────────────────────────────────
//   표 읽기 — 불변식을 여기서 건다
// ─────────────────────────────────────────────────────────────

/**
 * **VAD 상한이 모델 상한보다 작아야 한다.**
 *
 * 워커가 400초 리밋을 막는 방법은 "조심해서 자르자" 가 아니라 "그런 조각이
 * 만들어질 수 없게" 다 (`maxSpeechDuration: 30`). 그 방어가 성립하려면
 * 서술자 안에서 두 숫자의 관계가 지켜져야 한다.
 *
 * 모델을 하나 더 붙이면서 이 관계를 깨뜨리는 것은 아주 쉽다 — whisper 를
 * 붙이며 `maxAudioSeconds: 30` 만 적고 VAD 는 parakeet 것(30)을 그대로 두면,
 * 30초짜리 조각이 30초 창에 딱 맞아 들어가 **경계에서 잘린 채로 조용히**
 * 나온다. 그래서 뜰 때 한 번 검사하고, 어긋나면 앱을 세운다. 전사가 조용히
 * 틀린 글을 내는 것보다 안 뜨는 편이 낫다.
 */
function assertModel(m: AsrModel): AsrModel {
  const r = m.runtime;
  const bad = (why: string): never => {
    throw new Error(`[voicebento] 전사 모델 서술자가 어긋납니다 (${m.id}): ${why}`);
  };

  if (r.sampleRate !== 16000) {
    // silero VAD 가 다른 표본율을 아예 거절한다. 그 거절은 C++ 에서 나와
    // 잡을 수 없으므로 여기서 미리 막는다.
    bad(`sampleRate 가 ${r.sampleRate} 입니다. silero VAD 는 16000 만 받습니다.`);
  }
  if (r.maxAudioSeconds !== null && r.vad.maxSpeechDuration >= r.maxAudioSeconds) {
    bad(
      `VAD 조각 상한(${r.vad.maxSpeechDuration}초)이 모델 상한(${r.maxAudioSeconds}초)보다 ` +
        `작지 않습니다. 이대로면 모델을 넘어뜨리는 조각이 만들어질 수 있습니다.`,
    );
  }
  if (r.kind === "transducer" && !r.files.joiner) {
    bad("transducer 인데 joiner 파일이 없습니다.");
  }
  if (r.timestamps === "none" && m.timestampResolution !== null) {
    bad("시각을 안 주는 모델에 눈금이 적혀 있습니다.");
  }
  return m;
}

interface ModelTable {
  default: string;
  models: Record<string, AsrModel>;
  vad: { name: string; url: string; size: number; sha256: string };
}

/*
 * JSON 에는 `$comment` 같은 설명 칸이 섞여 있다 (주석을 못 다는 형식이라).
 * 읽는 쪽은 그것을 무시하면 되므로 모양만 맞춰 받는다.
 */
const TABLE = table as unknown as ModelTable;

export const MODEL_IDS: string[] = Object.keys(TABLE.models);
export const DEFAULT_MODEL_ID = TABLE.default;
export const VAD_FACTS = TABLE.vad;

/**
 * id 로 하나 꺼낸다. 모르는 id 면 **기본값으로 조용히 넘어가지 않는다.**
 *
 * 오타 난 `ASR_MODEL_ID` 가 조용히 parakeet 으로 떨어지면, 한국어 모델을
 * 붙였다고 믿는 사람이 여전히 한국어를 못 하는 앱을 쓰게 된다. 그건 화면
 * 어디에도 안 나온다.
 */
export function getModel(id: string): AsrModel {
  const m = TABLE.models[id];
  if (!m) {
    throw new Error(
      `[voicebento] 모르는 전사 모델 id 입니다: "${id}". ` +
        `아는 것: ${MODEL_IDS.join(", ")}. (scripts/asr-models.json)`,
    );
  }
  return assertModel(m);
}

// ─────────────────────────────────────────────────────────────
//   에이전트에게 알릴 것 (B)
// ─────────────────────────────────────────────────────────────

/**
 * 다듬기가 돌려줄 수 있는 **표시**. 허용목록이다.
 *
 * ## 왜 표시가 필요한가
 *
 * 다듬는 에이전트는 지금까지 모델이 무엇인지 몰랐다. 그래서 못 알아들은
 * 자리에서 나온 헛소리(`"Here's snucker, your foo's nick…"`)를 **매끄러운
 * 문장으로 "다듬어"** 버렸다. 다듬고 나면 그것이 사람이 한 말인지 기계가
 * 지어낸 것인지 화면에서 가를 방법이 사라진다.
 *
 * 모델의 제약을 알려 주면 다듬는 대신 **표시**하게 할 수 있다. 그 표시를
 * 돌려받는 자리가 이것이다.
 *
 * ## 왜 자유 문장이 아니라 열거값인가
 *
 * 화자 이름 칸은 이미 자유 문장을 받는다(길이를 자르고 제어문자를 털어서).
 * 표시까지 자유 문장으로 받으면 남이 만든 소리에서 나온 글이 화면에 앉는
 * 자리가 하나 더 생기는데, 얻는 것이 없다 — 무슨 말이었는지는 이미 `text`
 * 에 있다. 열거값이면 화면이 제 손으로 정한 딱지를 붙인다.
 *
 * 모르는 값은 **버린다** (fail closed). 표시가 없는 것과 같아지므로 늘 안전한
 * 실패다.
 */
export const SEGMENT_FLAGS = [
  /** 지원 목록 밖의 말로 보인다. 다듬지 않고 그대로 두었다. */
  "other-language",
  /** 소리를 못 알아듣고 기계가 지어낸 글로 보인다. */
  "hallucinated",
  /** 알아볼 수 없다. 지어내지 않고 그대로 두었다. */
  "unclear",
  /** 조각 끝에서 말이 잘렸다. 다음 조각으로 이어진다. */
  "cut-off",
] as const;

export type SegmentFlag = (typeof SEGMENT_FLAGS)[number];

export function isSegmentFlag(v: unknown): v is SegmentFlag {
  return typeof v === "string" && (SEGMENT_FLAGS as readonly string[]).includes(v);
}

/**
 * `context` 의 상한. 저쪽 `/voice/polish` 가 이 길이에서 **자른다.**
 *
 * 이제 여기 실리는 것은 세션 쪽지 한 줄과 사람이 적은 쪽지(최대 2,000자)뿐이라
 * 실제로 닿을 일이 없다. 그래도 검사를 남겨 두는 이유는, 닿는 날 저쪽이
 * **말없이 자르기** 때문이다 — 잘린 쪽지는 사람이 적은 그대로 갔다고 믿게 된다.
 * 모델의 사실은 더 이상 이 길로 안 간다 (`modelBrief` 를 보라).
 */
export const AGENT_CONTEXT_LIMIT = 4000;

/**
 * 에이전트에게 넘기는 **모델 서술.**
 *
 * ## 왜 글이 아니라 표인가
 *
 * 전에는 이 자리에서 안내문 한 덩어리를 지어 `context` 에 실어 보냈다.
 * 그 길에는 문제가 둘 있었다.
 *
 * 1. `context` 는 저쪽에서 **울타리에 갇힌다** (`fence(..., "transcript")`).
 *    울타리 안의 글은 "읽을 자료지 지시가 아니다" 로 읽힌다 — 그런데 여기
 *    적히는 것은 실제로 따라야 하는 사실이다. 울타리에 넣는 순간 무게가 준다.
 * 2. 저쪽에도 같은 것을 말하는 자리(`[받아 적은 기계]` 블록)가 있어서, 앱이
 *    안 보내면 저쪽은 "앱이 알려 주지 않았다. 아는 척하지 마라" 를 싣는다.
 *    글로 보내면 그 두 문장이 **한 프롬프트 안에서 서로를 부정한다.**
 *
 * 그래서 사실은 표로 보낸다. 저쪽이 모양을 좁혀 받고(`normalizeModelBrief`)
 * 울타리 없이 앞머리에 싣는다. **무엇을 시킬지는 저쪽 안내문이 정한다** —
 * 앱은 사실만 대고, 그 사실로 무엇을 할지는 에이전트 쪽 규율이다. 두 곳에서
 * 시키면 언젠가 한쪽만 고친다.
 *
 * ## 자유 문구는 `notes` 뿐이다
 *
 * 저쪽은 이 칸을 울타리 없이 싣는다. **그러니 여기 실리는 것은 서술자에
 * 코드로 적힌 글이어야 한다.** 사람이 친 글이나 파일 이름이 이 길로 오면
 * 그것이 곧 안내문이 된다. 사람이 준 것은 `context` 로 간다.
 *
 * 칸 이름은 BentoAgent 의 `ModelBrief` 를 그대로 따른다.
 */
export interface AgentModelBrief {
  id: string;
  name: string;
  /** ISO 639-1. 저쪽이 BCP-47 모양만 통과시킨다. */
  languages: string[];
  /** 사람이 읽는 한 줄. 200자 안쪽이어야 잘리지 않는다. */
  languageNote: string;
  timestamps: TimestampGranularity;
  /** `timestamps: "none"` 이면 저쪽이 버린다. 그래도 여기서 먼저 null 로 둔다. */
  timestampStepSec: number | null;
  maxAudioSec: number | null;
  /** VAD 조각의 상한. "왜 여기서 잘렸나" 의 근거다. */
  segmentMaxSec: number | null;
  hallucinatesOnUnsupported: boolean;
  notes: string[];
}

/** 저쪽 `MAX_BRIEF_NOTE`. 넘으면 **말없이 잘린다** — 넘기지 않는 것이 우리 몫이다. */
const BRIEF_NOTE_CHARS = 200;

export function modelBrief(m: AsrModel): AgentModelBrief {
  /*
   * "한국어는 없다" 를 손으로 적지 않는다. 지원 목록에서 만든다 — 한국어를
   * 하는 모델로 갈아 끼우는 날 이 문장이 저절로 사라져야 한다.
   */
  const note = m.languages.includes("ko")
    ? `${m.languagesLong}. 한국어도 알아듣는다.`
    : `${m.languagesLong}. 한국어는 없다.`;

  return {
    id: m.id,
    name: m.name,
    languages: [...m.languages],
    languageNote: note.slice(0, BRIEF_NOTE_CHARS),
    timestamps: m.runtime.timestamps,
    timestampStepSec: m.runtime.timestamps === "none" ? null : m.timestampResolution,
    maxAudioSec: m.runtime.maxAudioSeconds,
    segmentMaxSec: m.runtime.vad.maxSpeechDuration,
    hallucinatesOnUnsupported: m.hallucinatesOnUnsupported,
    /*
     * 넘치는 쪽지는 **자르지 않고 뺀다.** 200자에서 잘린 경고는 문장이
     * 반만 남아 뜻이 뒤집힐 수 있고("지어낸다" 가 잘려 나간다), 잘렸다는
     * 사실은 아무 데도 안 뜬다. 통째로 빠지면 적어도 거짓말은 아니다.
     */
    notes: m.agentNotes.filter((n) => n.length <= BRIEF_NOTE_CHARS),
  };
}

/**
 * 대화·요약에 실어 보내는 **짧은 판.**
 *
 * 다듬기용 안내를 그대로 쓰지 않는다. 저쪽은 "이렇게 표시해라" 를 시키는
 * 글이고, 대화창에는 표시할 자리가 없다 — 여기서 필요한 것은 "전사문을
 * 얼마나 믿을 것인가" 하나다.
 */
export function agentReadingCaveat(m: AsrModel): string {
  const parts = [
    `이 전사문은 ${m.name} 이 받아 적었다. 알아듣는 말은 ${m.languagesLabel}이고, ` +
      `그 밖의 말(${m.languages.includes("ko") ? "" : "한국어를 포함해 "}목록에 없는 말)은 알아듣지 못한다.`,
  ];
  if (m.hallucinatesOnUnsupported) {
    parts.push(
      "못 알아들은 자리에는 빈 글이 아니라 그럴듯한 글이 들어가 있을 수 있다. " +
        "앞뒤와 동떨어진 대목을 두고 무슨 말이었을지 지어내지 마라.",
    );
  }
  parts.push(
    m.runtime.timestamps === "none"
      ? "낱말별 시각은 없다. 조각의 시작·끝만 말해 줄 수 있다."
      : "시각은 믿을 만하다. 몇 분쯤이냐고 물으면 적힌 시각을 그대로 말해라.",
  );
  return parts.join(" ");
}
