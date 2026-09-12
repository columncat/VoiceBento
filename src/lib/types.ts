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
  /**
   * 소리를 들어 화자를 가르는 중. **전사문은 이미 온전하다.**
   *
   * 계약에 값을 하나 더한 것이라 가볍게 볼 일이 아니다. 그래도 더한 이유:
   * 60분짜리면 여기서 7~9분이 더 걸리는데 그동안 `transcribing` 이라고 적으면
   * 진행 막대가 멎은 채로 몇 분이 흐른다. 화면이 거짓말을 하는 것보다 값을
   * 하나 더 아는 편이 낫다. `db/schema.ts` 의 `JOB_STATES` 와 **같아야 한다.**
   */
  | "diarizing"
  | "polishing"
  | "done"
  | "failed";

/** 화자 분리가 어디까지 갔나. `state` 와 별개다 — `db/schema.ts` 의 설명을 보라. */
export type SpeakerState = "none" | "running" | "done" | "failed" | "skipped";

/** 이 줄의 화자를 누가 정했나. `agent-guess` 는 **소리를 안 들은** 추정이다. */
export type SpeakerSource = "agent-guess" | "acoustic" | "human";

/** 한 조각 안에서 "여기부터 여기까지는 군집 k". 시각은 전체 기준 초. */
export interface SpeakerRunDTO {
  k: number;
  s: number;
  e: number;
  /** 실루엣. **"틀렸다" 가 아니라 "덜 확실하다" 로만 쓴다.** 모르면 null. */
  sil: number | null;
}

export interface SegmentDTO {
  id: string;
  /** 전체 기준 초. VAD 조각 시작. */
  start: number;
  end: number;
  /** 에이전트가 다듬기 전의 날 것. 되돌리기의 기준이라 절대 안 지운다. */
  raw: string;
  /** 사람이 읽는 글. 에이전트가 다듬었거나 사람이 고친 것. */
  text: string;
  /**
   * 이 줄의 화자 이름. 없으면 null.
   *
   * **소리로 가른 줄에서는 서버가 군집 번호를 이름으로 풀어 여기 담아 준다**
   * (`diarizations.names`, 아직 이름이 없으면 "화자 1" 같은 임시 이름).
   * 화면은 예전과 똑같이 이 칸만 읽으면 된다 — 무엇을 근거로 붙은 이름인지는
   * 아래 `speakerSource` 가 말한다.
   */
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

  /*
   * ── 아래 넷은 화자 분리가 붙인 것. 전부 **선택 사항**이다. ───────────
   *
   * 계약의 세 모양은 칸을 늘리지 않기로 한 자리라 선택으로만 더한다. 옛
   * 녹음과 분리를 못 한 녹음에는 이 칸들이 아예 없고, 그때 화면은 예전처럼
   * `speaker` 한 칸으로 그리면 된다.
   */

  /**
   * 이 이름을 누가 정했나. **`agent-guess` 는 소리를 안 들은 추정이다.**
   *
   * 화면은 이 둘을 같은 얼굴로 그리면 안 된다. 근거가 다른 값을 나란히
   * 놓으면 사람은 둘 다 같은 무게로 믿는다.
   */
  speakerSource?: SpeakerSource | null;

  /** 소리로 가른 군집 번호 (이 조각에서 가장 오래 말한 것). 이름이 아니다. */
  speakerCluster?: number | null;

  /**
   * **한 줄 안에서 화자가 바뀌는 자리.** 비어 있으면 줄 통째로 한 사람이다.
   *
   * 왜 이것이 필요한가: AMI 9편에서 VAD 조각의 **52.2%**에 정답 화자가 둘
   * 이상 들어 있었다. 줄 통째로 한 사람을 붙이면 낱말 정확도가 61.9% 인데
   * 이 토막으로 나누면 73.5% 다. 화면이 이걸 안 쓰면 그 차이가 버려진다.
   *
   * 토막은 조각의 [start, end] 를 **빈틈없이** 덮는다. 낱말 시각이 있으면
   * 낱말을 시각으로 나눠 담고, 없으면(`ModelNoticeDTO.timestamps === "none"`)
   * 글자 수에 비례해 나눠 담으면 된다 — 저장된 모양이 둘 다 같다.
   */
  speakerRuns?: SpeakerRunDTO[];

  /**
   * 이 줄 으뜸 군집의 실루엣. 모르면 null.
   *
   * **"덜 확실하다" 까지만 말해라.** 낱말 단위로 재면 문턱(−0.2)에 걸린 낱말의
   * 정밀도 80.4% · 재현율 7.7% 다 — 다섯에 하나는 멀쩡하고 틀린 낱말의 대부분에는
   * 표시가 없다. 줄 단위로는 잰 적이 없다. 어느 줄에 표시할지는 화면과 서버가
   * `lib/speaker-doubt.ts` 한 곳에서 정한다.
   */
  speakerSil?: number | null;
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
  /**
   * 이 세션에 붙은 녹음 가운데 **가장 최근에 적힌 화자 목록.** 없으면 빈 배열.
   *
   * 반복 회의에 이어 올릴 때 목록 칸을 **채워서 보여 주는** 재료다. 말없이 물려받게
   * 하지 않는다 — 회차마다 참석자가 다를 수 있어, 화면이 채운 채로 사람에게 보이고
   * 사람이 고친 뒤에 올린다.
   */
  lastRoster: string[];
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

  /**
   * 화자 분리가 어디까지 갔나. **`state` 와 별개다.**
   *
   * 분리가 어떻게 실패하든 전사문은 온전하고 `state` 는 `done` 이다. 그래서
   * 실패는 여기 앉는다 — 화면은 이 둘을 따로 그려야 한다. 분리가 실패한
   * 녹음을 "실패" 로 그리면 멀쩡히 읽히는 전사문에 빨간 글씨가 붙는다.
   */
  speakerState: SpeakerState;
  /** 왜 못 붙였나. 사람이 읽는 문장. 없으면 null. */
  speakerError: string | null;
}

/**
 * 화자 분리 한 판. **날 구간(`turns`)은 안 싣는다** — 화면이 쓸 것이 없다.
 *
 * 저장은 해 둔다 (`diarizations.turns`). 문턱만 바꿔 다시 붙일 때 7분짜리
 * 워커를 다시 안 돌리려는 것이고, 그건 서버 안에서만 쓰인다.
 */
export interface DiarizationDTO {
  /** 어느 모델로 돌렸나. */
  modelId: string;
  /** 이 판을 돌릴 때 사람이 적어 준 목록. */
  roster: string[];
  /** 워커에게 준 무리 수 `k` (= 목록 인원 + 2). */
  clusters: number;
  /** 실제로 나온 군집 수. */
  found: number;
  /** 군집마다 맡은 시간 (초), **많은 순.** 이름을 나눠 줄 때 쓰는 순서다. */
  talkTime: { k: number; seconds: number }[];
  /** 군집 → 이름. 에이전트가 채운다. 아직 없으면 빈 객체. */
  names: Record<string, string>;
  /** 구간 실루엣의 중앙값. 모르면 null. */
  silhouetteMedian: number | null;
  /**
   * 이 녹음을 통째로 의심해야 하나 (`silhouetteMedian ≤ 문턱`).
   *
   * **서버가 판단해서 준다.** 문턱은 임베딩 모델마다 다른 값이라
   * (`fileWarnSilhouetteMedian`) 화면이 손으로 든 숫자를 쓰면 모델을 갈아
   * 끼우는 날 옛말이 된다.
   */
  lowConfidence: boolean;
  /**
   * 화자 신뢰도(실루엣)를 **재지 못했다면** 그 이유. 쟀으면 null.
   *
   * `lowConfidence: false` 와 뜻이 전혀 다르다. 저쪽은 "재 보니 괜찮다" 이고
   * 이쪽은 "재지 못해 모른다" 다. 이 칸이 서 있으면 파일 경고도 줄마다의
   * "덜 확실하다" 도 **붙을 수가 없는** 판이라, 화면은 표시가 없는 것을 "확실하다"
   * 로 읽히지 않게 이 사실을 따로 말해야 한다.
   */
  silhouetteMissing: string | null;
  /**
   * 다시 나누면서 **어느 목소리인지 뚜렷하게 짝짓지 못해 옮기지 못한, 사람이 붙인 이름.**
   *
   * 이름은 번호가 아니라 목소리에 붙은 것이라 다시 나눌 때 겹친 시간으로 옮긴다.
   * 두 목소리가 한 군집으로 합쳐지거나 한 목소리가 반반으로 갈리면 어느 쪽에
   * 줘도 남의 이름이 되므로 안 옮기고 여기 남긴다. **조용히 사라지면 안 된다** —
   * 화면이 "다시 확인해 주세요" 로 띄운다. 사람이 이름 표를 저장하면 비워진다.
   */
  recheckNames: string[];
  /** 언제 돌렸나. ISO. */
  at: string;
  /**
   * 이 판의 **군집 번호가 무엇을 뜻하나**를 가리키는 표지 (`diarRunId`).
   *
   * 이름 표를 저장할 때 **반드시 함께 보낸다** (`PATCH …/speakers`). 번호의 뜻은 판마다
   * 바뀌므로, 화면이 들고 있던 초안이 옛 판의 것이면 서버가 409 로 거절한다 — 그러지
   * 않으면 옛 번호의 이름이 새 판의 **다른 목소리**에 사람의 것으로 잠겨 앉는다.
   * `at` 과 다르다: 저쪽은 이름만 저장해도 바뀐다.
   */
  run: string;
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

  /**
   * 계약 밖. 이 녹음의 화자 분리 한 판. 안 했으면 null.
   *
   * **선택 칸이다.** 이 봉투를 만드는 라우트를 아직 안 고친 단계에서도
   * 타입이 깨지지 않아야 한다 — 깨지면 고치는 사람이 급한 마음에 값을
   * 지어내 채운다.
   */
  diarization?: DiarizationDTO | null;

  /**
   * 계약 밖. **화자 분리 기능 자체**에 대한 고정 안내. 녹음마다 다르지 않다.
   *
   * `ModelNoticeDTO` 와 같은 결이다 — 화면이 손으로 든 숫자를 쓰지 않게
   * 하려고 서버가 서술자에서 떠서 보낸다. 여기 실리는 것 넷이 다 그런 값이다:
   * 기다림을 어림할 `rtf`, "너무 길다" 를 미리 말할 `maxAudioSeconds`,
   * 목록을 어떻게 물어야 하는지(`rosterHint`), 그리고 **출처 고지**.
   * 고지는 장식이 아니라 의무다 (분할 모델이 MIT 라 저작권 표시를 실어야 한다).
   */
  diar?: DiarNoticeDTO | null;

  /**
   * 계약 밖. 이 녹음에 적혀 있는 화자 목록. 아직 안 적었으면 빈 배열.
   *
   * `diarization.roster` 와 다르다 — 저쪽은 **그때 그 판을 돌릴 때** 쓴
   * 목록이고 이것은 지금 적혀 있는 것이다. 분리가 실패하거나 건너뛰어
   * `diarization` 자체가 없을 때도 사람이 적어 둔 이름은 남아야 한다.
   */
  roster?: string[];
}

/**
 * 화자 분리 기능에 대한 고정 안내. **녹음마다 다른 값이 아니다.**
 *
 * 왜 `DiarizationDTO` 에 안 넣었나: 저쪽은 "이 녹음을 이렇게 나눴다" 는
 * 한 판의 기록이라 분리를 한 번도 안 한 녹음에는 없다. 그런데 화면이 이
 * 값들을 **가장 필요로 하는 때가 바로 그때**다 — 아직 안 나눈 녹음에
 * 목록 칸을 그리고, 얼마나 걸릴지 적고, 너무 길면 미리 말해야 한다.
 */
export interface DiarNoticeDTO {
  /** 서술자 id (`scripts/diar-models.json`). */
  modelId: string;
  /** 사람이 읽는 모델 이름. */
  name: string;
  /** 실시간 대비 처리 시간. 화면이 "몇 분 걸립니다" 를 적는 데 쓴다. */
  rtf: number | null;
  /** 이보다 긴 소리는 안 나눈다 (초). */
  maxAudioSeconds: number;
  /** 목록을 어떻게 물어야 하는가. **"모르면 넉넉히 적으세요"** 가 여기 있다. */
  rosterHint: string;
  /** 목록에 없던 사람에게 붙는 이름. 화면이 이 글자를 지어내면 안 된다. */
  otherLabel: string;
  /**
   * 이 녹음을 통째로 의심할 실루엣 문턱 (`fileWarnSilhouetteMedian`).
   *
   * 파일 단위 판단은 서버가 이미 해서 `DiarizationDTO.lowConfidence` 로 준다.
   * **줄 단위 표시에는 쓰지 않는다** — 파일 중앙값에 대해 잰 눈금이라 낱말에
   * 걸면 표시 13.6% · 정밀도 63.2% 로 뜻이 달라진다. 줄에는 아래 `unsureSilhouette`.
   */
  warnSilhouette: number;
  /**
   * 줄마다 "덜 확실하다" 를 붙일 **낱말 실루엣 문턱** (`wordSilhouette.flagAt`). 모르면 null.
   *
   * 에이전트의 `?` 와 **같은 값·같은 규칙**이다 (`lib/speaker-doubt.ts`). 화면이
   * 제 손으로 눈금을 지으면 사람이 대화창에서 "`?` 붙은 줄" 을 물었을 때
   * 에이전트가 짚는 줄과 화면의 표시가 달라진다. null 이면 이 모델의 실력을
   * 재 두지 않았다는 뜻이고, 그때는 아무 줄에도 표시하지 않는다.
   */
  unsureSilhouette: number | null;
  /** 출처 고지. **의무다.** 화면 어딘가에 그대로 적는다. */
  attribution: string;
  /**
   * 모델 파일이 준비돼 있나.
   *
   * 없으면 단추를 눌러도 건너뛴다 (`whyNotDiarize`). 그 사실을 미리 말하지
   * 않으면 사람은 눌러 보고 몇 분 기다린 뒤에야 안다.
   */
  ready: boolean;
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
