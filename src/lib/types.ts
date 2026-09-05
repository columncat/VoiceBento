/**
 * 화면과 서버가 주고받는 모양. **여기가 정본이다.**
 *
 * 아래 `JobState`·`SegmentDTO`·`RecordingDTO` 셋은 계약서에 못 박힌 글자
 * 그대로다. 칸을 늘리거나 이름을 바꾸지 마라 — 화면과 서버가 각자 고쳐
 * 갈라지는 순간, 어긋난 것을 알아채는 자리가 런타임의 `undefined` 하나뿐이 된다.
 *
 * 계약에 없던 것(응답 봉투에 얹는 것, 대화·요약의 몸통)은 아래쪽에 따로
 * 모아 두었다. 그쪽은 늘려도 된다 — 다만 봉투에 **키를 더하는 것**까지고,
 * 계약이 정한 키의 뜻을 바꾸는 것은 아니다.
 */

export type JobState =
  | "queued"
  | "extracting"
  | "transcribing"
  | "polishing"
  | "done"
  | "failed";

export interface SegmentDTO {
  id: string;
  /** 전체 기준 초. VAD 조각 시작. */
  start: number;
  end: number;
  /** 에이전트가 다듬기 전의 날 것. 되돌리기의 기준이라 절대 안 지운다. */
  raw: string;
  /** 사람이 읽는 글. 에이전트가 다듬었거나 사람이 고친 것. */
  text: string;
  /** 에이전트가 대사에서 추정한 화자. 없으면 null. */
  speaker: string | null;
  /**
   * 낱말별 시각. `[{ w, t }]` — 낱말 클릭에 쓴다.
   *
   * **비어 있는 것이 두 가지 뜻이다.** 이 조각에서 낱말을 못 뽑았거나,
   * 이 모델이 애초에 낱말 시각을 안 주거나. 둘을 가르는 것은 여기가 아니라
   * `ModelNoticeDTO.timestamps` 다 — 그것이 `"none"` 이면 낱말 클릭을 아예
   * 접어라. 조각마다 판단하면 말이 없던 조각 하나 때문에 기능이 깜빡인다.
   */
  words: { w: string; t: number }[];
  /** 사람이 고쳤나. 고친 것은 다시 다듬어도 안 덮는다. */
  edited: boolean;
  /**
   * 다듬기가 붙인 표시. 없으면 null. **계약 밖(선택).**
   *
   * 에이전트가 "이 줄은 다듬지 않았다, 그리고 그 이유는 이것이다" 를
   * 돌려주는 자리다. 값은 `asr-models.ts` 의 `SEGMENT_FLAGS` 넷 중 하나이고
   * 모르는 값은 서버가 버린다 (fail closed).
   *
   * - `other-language` — 이 모델이 모르는 말이라 손대지 않았다.
   * - `hallucinated` — 기계가 지어낸 글로 보인다. **사람이 한 말이 아닐 수 있다.**
   * - `unclear` — 알아볼 수 없어 그대로 두었다.
   * - `cut-off` — 조각 끝에서 말이 잘렸다. 다음 줄로 이어진다.
   */
  flag?: "other-language" | "hallucinated" | "unclear" | "cut-off" | null;
}

export interface RecordingDTO {
  id: string;
  title: string;
  /** MemoBento 파일 id. 재생·다시 전사에 쓴다. */
  fileId: string | null;
  /** 초. 모르면 null. */
  duration: number | null;
  state: JobState;
  /** 0~1. 전사 중일 때만. */
  progress: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
//   계약 밖 — 봉투에 얹는 것들
// ─────────────────────────────────────────────────────────────

/**
 * 이 앱이 쓰는 전사 모델에 대한 고정 안내. **한국어를 못 한다는 말이 여기 있다.**
 *
 * `RecordingDTO` 에 칸을 파지 않은 것은 계약을 지키려는 것도 있지만, 이건
 * 녹음마다 다른 값이 아니라 **앱 전체에 늘 참인 사실**이기 때문이다. 목록
 * 응답(`GET /api/recordings`)에 한 번 실어 보내고 화면이 어디든 원하는 곳에
 * 적으면 된다.
 *
 * 왜 이 말이 필요한가: `nvidia/parakeet-tdt-0.6b-v3` 의 어휘 8,193개에 한글이
 * 하나도 없다. 한국어를 넣으면 오류가 나는 것이 아니라 **빈 글이나 엉뚱한
 * 로마자**가 나온다. 그 사실을 미리 말하지 않으면 사람은 파일이 잘못된 줄 알고
 * 같은 것을 몇 번씩 다시 올린다.
 */
export interface ModelNoticeDTO {
  /** 모델 이름. 화면에 그대로 적어도 되는 값. */
  name: string;
  /** 알아듣는 말. 사람이 읽는 짧은 목록. */
  languages: string;
  /** 한국어를 못 하나. 이제 손으로 적지 않는다 — 지원 언어 목록에서 나온다. */
  koreanUnsupported: boolean;
  /** 화면에 그대로 띄울 한 문단. */
  notice: string;

  /*
   * ── 아래는 전부 선택 사항이다. **일부러 그렇게 했다.** ──────────────
   *
   * 화면 쪽에는 서버가 이 칸을 못 줬을 때를 위한 기본값이 있다
   * (`components/language-notice.tsx` 의 `FALLBACK_MODEL`). 여기에 필수
   * 칸을 더하면 그 기본값이 타입 검사에서 터지고, 그러면 **이 안내가
   * 화면에서 사라지는 것이 가장 나쁜 결과**인데 그 길로 떠밀게 된다.
   * 그래서 늘리는 것은 선택 칸으로만 한다.
   */

  /** 서술자 id (`scripts/asr-models.json`). */
  id?: string;
  /** 알아듣는 말. 사람이 읽는 긴 목록. */
  languagesLong?: string;
  /** 알아듣는 말 (ISO 639-1). 화면이 제 손으로 판단할 재료. */
  languageCodes?: string[];
  /**
   * **낱말 클릭을 켤 수 있는가.**
   *
   * `"none"` 이면 이 모델은 낱말 시각을 아예 안 준다 (sherpa-onnx 의
   * whisper 가 그렇다 — 실측). 그때 화면은 낱말 클릭을 접고 줄 클릭만
   * 남겨야 한다. 이 칸이 없으면 화면은 "이 조각에 낱말이 없다" 와
   * "이 모델은 원래 안 준다" 를 가를 수 없다.
   */
  timestamps?: "none" | "token" | "word";
  /** 시각의 눈금(초). 시각을 안 주면 null. */
  timestampResolution?: number | null;
  /** 한 조각의 최대 길이(초). "왜 여기서 잘렸나" 를 설명할 재료. */
  segmentMaxSeconds?: number;
  /**
   * 실시간 대비 처리 시간. 모르면 null.
   *
   * 화면이 "1시간이면 약 몇 분" 을 적는 데 쓴다. 이 칸이 없으면 화면은 제
   * 손으로 든 값을 쓸 수밖에 없고, 그 값은 모델을 갈아 끼우는 날 옛말이 된다.
   */
  rtf?: number | null;
  /** 출처 고지. **장식이 아니라 의무다** (가중치 라이선스). */
  attribution?: string;
  credit?: {
    weights: string;
    weightsLicense: string;
    export: string;
    exportLicense: string;
  };
}

/** 이 녹음 하나에 대해 서버가 알아챈 것. 없으면 null. */
export interface RecordingNoticeDTO {
  /**
   * `maybe-korean` — 소리는 긴데 나온 글이 거의 없다. 한국어(또는 이 모델이
   * 모르는 말) 오디오일 때 나오는 모양이다.
   * `mostly-empty` — 조각 대부분이 빈 글이다. 말이 아닌 소리였을 수 있다.
   */
  kind: "maybe-korean" | "mostly-empty";
  text: string;
}

// ─────────────────────────────────────────────────────────────
//   세션 — 녹음 여럿이 한 맥락을 나눠 쓴다
// ─────────────────────────────────────────────────────────────

/**
 * 세션 하나. **녹음이 여럿 붙을 수 있다.**
 *
 * ## 무엇이 달라졌나
 *
 * 예전에는 녹음 하나가 곧 세션이었다 (`recordingId` 로 에이전트 세션을
 * 잡았다). 그래서 다듬기는 일회용이었고, 방금 다듬으며 정한 화자 이름과
 * 용어를 대화창은 전혀 몰랐다.
 *
 * 이제 **한 전사문은 한 세션에서 처리된다** — 다듬기와 대화가 같은 에이전트
 * 세션을 쓴다. 그러면 주간 회의처럼 같은 사람·같은 용어가 되풀이되는
 * 녹음들이 지난 회차의 화자 이름과 낱말을 물려받는다. 그것이 이 기능의 값이다.
 *
 * ## 맥락은 무한하지 않다
 *
 * 세션에 녹음이 쌓이면 에이전트 맥락도 함께 자라고 줄어들지 않는다.
 * `contextChars` 가 지금까지 부은 양이고 `contextLimit` 이 상한이다.
 * **넘치면 조용히 자르지 않는다** — 서버가 409 로 거절하고, 사람은 새
 * 세션으로 옮기거나 이 세션의 맥락을 갈아 끼운다(`rollover`).
 */
export interface SessionDTO {
  id: string;
  name: string;
  /** 이 세션에 붙어 있는 녹음 수. */
  recordingCount: number;
  /** 지금까지 에이전트 맥락에 부은 글자 수. */
  contextChars: number;
  /** 상한. `SESSION_CONTEXT_CHARS`. */
  contextLimit: number;
  /** 상한을 넘어 더 못 붓는 상태. 화면이 **미리** 알려 줄 재료. */
  contextFull: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 녹음에 세션을 얹은 것.
 *
 * `RecordingDTO` 를 넓히지 않고 **넓힌 것을 따로 둔다.** 계약서에 못 박힌
 * 세 모양(`JobState`·`SegmentDTO`·`RecordingDTO`)은 칸을 늘리지 않기로 한
 * 자리라서다. 이건 그 셋을 그대로 두고 상속만 한 것이라, `RecordingDTO` 로
 * 받는 옛 코드는 하나도 안 고쳐도 된다.
 *
 * `sessionId` 가 null 인 녹음이 있다 — 세션이 생기기 전에 올린 것과, 붙어
 * 있던 세션이 지워진 것. 그때는 예전처럼 **녹음 하나가 곧 세션**이다.
 */
export interface RecordingWithSession extends RecordingDTO {
  sessionId: string | null;
  sessionName: string | null;
}

/** `GET /api/recordings` */
export interface RecordingListResponse {
  recordings: RecordingWithSession[];
  /** 계약 밖. 화면이 "이 모델은 한국어를 못 합니다" 를 적을 재료. */
  model: ModelNoticeDTO;
  /** 계약 밖. 올릴 때 고를 수 있는 세션들. 최근에 손댄 순. */
  sessions: SessionDTO[];
}

/** `GET /api/recordings/[id]` */
export interface RecordingDetailResponse {
  recording: RecordingWithSession;
  segments: SegmentDTO[];
  /** 계약 밖. 이 녹음에서 서버가 알아챈 것 (한국어 같다 등). */
  notice: RecordingNoticeDTO | null;
  /** 계약 밖. 다듬기가 실패했다면 그 이유. 녹음은 멀쩡하다. */
  polishError: string | null;
  /** 계약 밖. 이 녹음이 붙어 있는 세션. 없으면 null. */
  session: SessionDTO | null;
  /**
   * 계약 밖. 이 앱이 쓰는 전사 모델.
   *
   * 목록 응답에도 실려 있지만 **전사문 화면은 목록을 안 거치고 바로 열릴 수
   * 있다** (주소를 붙여넣거나 새로고침하는 경우). 그때 `timestamps` 를 모르면
   * 낱말 클릭을 켤지 접을지 판단할 근거가 없다.
   */
  model: ModelNoticeDTO;
}

/** `GET /api/sessions` */
export interface SessionListResponse {
  sessions: SessionDTO[];
}

/** 에이전트를 지금 부를 수 있나. 못 부르면 이유를 문장으로 준다. */
export interface AgentAvailability {
  ready: boolean;
  reason: string | null;
}

export interface ChatTurn {
  role: "me" | "agent";
  text: string;
  /** epoch ms. */
  at: number;
}

/** `GET …/chat` — 지난 대화. */
export interface ChatHistory {
  agent: AgentAvailability;
  turns: ChatTurn[];
}

/** `GET …/chat?job=` — 도는 중인 한 번의 대화. */
export interface ChatStatus {
  state: string;
  elapsedMs: number;
  reply?: string;
  isError?: boolean;
  /** 도구를 몇 번 썼나. 진행 표시에만 쓴다. */
  toolCount?: number;
  lastTool?: string;
  /** 허용되지 않은 도구를 쓰려 했다면 그 이름들. */
  denials?: string[];
}

export interface SummaryDTO {
  body: string;
  /** 사람이 쓴 것과 에이전트가 쓴 것을 가른다. 덮어쓰기 확인에 쓴다. */
  source: "agent" | "human";
  /** 에이전트에게 무엇을 시켰는지. 되짚어 볼 수 있게 남긴다. */
  instruction: string | null;
  updatedAt: string;
}

export interface SummaryRun {
  id: string;
  state: "running" | "done" | "failed";
  error: string | null;
}

export interface SummaryResponse {
  run: SummaryRun | null;
  summary: SummaryDTO | null;
}

/**
 * 다듬기를 시작시킨 결과. 진행은 녹음의 `state` 로 따라간다.
 *
 * `jobId` 가 null 일 수 있다 — **같은 세션의 다른 녹음을 다듬는 중이라 줄을
 * 선 경우다.** 그때 `queued` 가 true 이고, 녹음의 `state` 는 이미
 * `polishing` 이다 (줄에 선 것도 다듬는 중이다). 차례가 오면 서버가 알아서
 * 시작하므로 화면은 평소처럼 `state` 만 따라가면 된다.
 *
 * 왜 줄을 세우나: 한 세션은 에이전트 쪽에서 claude 세션 하나이고, 거기에
 * `--resume` 이 동시에 둘 붙으면 맥락이 꼬인다.
 */
export interface PolishStart {
  jobId: string | null;
  /** 줄을 서 있나. 없으면 곧바로 시작한 것이다. */
  queued?: boolean;
  /** 앞에 몇 건이 있나. 화면이 "앞에 N건" 을 말할 수 있게. */
  aheadInSession?: number;
}

/**
 * 올릴 때·만들 때 세션을 고르는 칸. **둘 중 하나만 준다.**
 *
 * - `sessionId` — 이미 있는 세션에 이어 붙인다.
 * - `newSessionName` — 그 이름으로 새 세션을 만들어 붙인다.
 * - 둘 다 없으면 세션 없이 둔다 (예전처럼 녹음 하나가 곧 세션).
 *
 * 둘 다 오면 서버가 400 으로 거절한다 — 어느 쪽이 뜻인지 짐작하지 않는다.
 */
export interface SessionPick {
  sessionId?: string;
  newSessionName?: string;
}

/**
 * 요약 기본 지시문.
 *
 * 설정에 다른 것이 적혀 있으면 그것이 이긴다 (`app_config.settings`).
 * 여기 있는 것은 아무것도 안 적혀 있을 때의 값이다.
 */
export const DEFAULT_SUMMARY_PROMPT = [
  "이 녹음의 전사문을 읽고 요약해라.",
  "",
  "- 무엇에 대한 이야기였는지 두세 문장으로 먼저 적는다.",
  "- 오간 이야기의 줄기를 항목으로 나눈다.",
  "- 정해진 것과 다음에 할 일이 있으면 따로 모은다.",
  "- 화자가 나뉘어 있으면 누가 무엇을 말했는지 살려서 적는다.",
].join("\n");

/**
 * 다듬기 기본 맥락.
 *
 * 사람이 "무슨 녹음인지" 를 한 줄 적어 주면 화자 추정과 용어 교정이 크게
 * 달라진다. 안 적으면 이 값이 대신 간다.
 */
export const DEFAULT_POLISH_CONTEXT = "";
