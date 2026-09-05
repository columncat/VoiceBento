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
  /** 낱말별 시각. `[{ w, t }]` — 낱말 클릭에 쓴다. */
  words: { w: string; t: number }[];
  /** 사람이 고쳤나. 고친 것은 다시 다듬어도 안 덮는다. */
  edited: boolean;
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
  /** 한국어를 못 한다는 사실. 늘 true — 다른 모델로 갈아 끼우기 전까지는. */
  koreanUnsupported: boolean;
  /** 화면에 그대로 띄울 한 문단. */
  notice: string;
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

/** `GET /api/recordings` */
export interface RecordingListResponse {
  recordings: RecordingDTO[];
  /** 계약 밖. 화면이 "이 모델은 한국어를 못 합니다" 를 적을 재료. */
  model: ModelNoticeDTO;
}

/** `GET /api/recordings/[id]` */
export interface RecordingDetailResponse {
  recording: RecordingDTO;
  segments: SegmentDTO[];
  /** 계약 밖. 이 녹음에서 서버가 알아챈 것 (한국어 같다 등). */
  notice: RecordingNoticeDTO | null;
  /** 계약 밖. 다듬기가 실패했다면 그 이유. 녹음은 멀쩡하다. */
  polishError: string | null;
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

/** 다듬기를 시작시킨 결과. 진행은 녹음의 `state` 로 따라간다. */
export interface PolishStart {
  jobId: string;
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
