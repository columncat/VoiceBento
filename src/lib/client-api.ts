import { apiPath } from "./api-path";
import { readJson } from "./read-json";
import type {
  ChatHistory,
  ChatStatus,
  PolishStart,
  RecordingDTO,
  RecordingDetailResponse,
  RecordingListResponse,
  SegmentDTO,
  SummaryResponse,
} from "./types";

/**
 * 브라우저에서 서버를 부르는 자리. **화면 담당이 만들었다.**
 *
 * 계약서에 적힌 주소만 여기 모은다. 화면 컴포넌트가 주소 문자열을 직접 들면
 * 라우트를 하나 옮길 때 고칠 자리가 열 곳이 되고, `apiPath()` 를 빠뜨린 곳이
 * 하나 생기면 하위 경로 배포에서만 조용히 404 가 난다 — MemoBento 에서 실제로
 * 겪은 일이라 부르는 길을 하나로 좁혀 둔다.
 *
 * **몸통 모양은 여기서 정의하지 않는다.** 전부 `types.ts` 에서 가져온다.
 * 화면이 자기 몫의 타입을 따로 들면 서버가 칸 하나를 옮겨도 타입 검사가
 * 통과해 버린다 — 어긋난 것을 알아채는 자리가 런타임뿐이 된다.
 *
 * ## 계약에 없어서 **여기서 정한 것** (뼈대 담당이 보고 맞추거나 고쳐야 한다)
 *
 * 계약서의 라우트 표에는 녹음·조각·다듬기·요약·대화가 있고, **올리기가 없다.**
 * 그런데 `POST /api/recordings { fileId, title }` 는 파일이 이미 어딘가로
 * 올라가 `fileId` 를 받은 뒤라는 뜻이고, Cloudflare 무료 플랜의 100MB 본문
 * 한계 때문에 한 시간짜리 영상은 쪼개 올려야 한다. 그래서 PaperBento 의
 * 3단(init/chunk/finish)을 그대로 본떠 아래 네 주소를 가정했다
 * (부르는 곳은 `components/upload-queue.ts` 하나뿐이다):
 *
 *   POST   /api/upload/init   { name, size, title }  → { uploadId, chunkSize }
 *   PUT    /api/upload/chunk?id=&index=   (octet-stream 본문)
 *   POST   /api/upload/finish { uploadId, title }    → { fileId } 또는 { recording }
 *   DELETE /api/upload/finish?id=                     (반쯤 올린 것 치우기)
 *
 * 대화와 요약도 계약서에는 주소만 있고 **메서드와 조회 문자열이 없다.**
 * PaperBento 의 같은 자리(`/api/papers/[id]/chat`, `…/summarize`)와 같은
 * 모양으로 맞춰 두었다:
 *
 *   GET    …/chat            → ChatHistory
 *   POST   …/chat  { message } → { id }        (작업 번호)
 *   GET    …/chat?job=<id>   → ChatStatus
 *   DELETE …/chat            → 이 녹음의 대화만 지우기
 *   GET    …/summary         → SummaryResponse
 *   POST   …/summary { instruction?, overwrite? } → SummaryResponse (run 이 돈다)
 *   GET    …/summary?id=<runId> → SummaryResponse
 */

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiPath(url), { cache: "no-store", signal });
  return readJson<T>(res);
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(apiPath(url), {
    method,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return readJson<T>(res);
}

const enc = encodeURIComponent;

export const api = {
  // ── 녹음 ────────────────────────────────────────────────
  /** 목록. 모델 안내(한국어 미지원)가 같은 봉투에 실려 온다. */
  list: (signal?: AbortSignal) => get<RecordingListResponse>("/api/recordings", signal),

  /** 올린 파일로 녹음 한 건을 세운다. 서버가 곧바로 전사 줄에 넣는다. */
  create: (fileId: string, title: string) =>
    send<{ recording: RecordingDTO }>("/api/recordings", "POST", { fileId, title }).then(
      (j) => j.recording,
    ),

  detail: (id: string, signal?: AbortSignal) =>
    get<RecordingDetailResponse>(`/api/recordings/${enc(id)}`, signal),

  rename: (id: string, title: string) =>
    send<{ recording: RecordingDTO }>(`/api/recordings/${enc(id)}`, "PATCH", { title }).then(
      (j) => j.recording,
    ),

  remove: (id: string) => send<unknown>(`/api/recordings/${enc(id)}`, "DELETE"),

  /**
   * 다시 전사.
   *
   * 202 만 돌아온다 — 새 전사문은 몇 분 뒤에나 생긴다. 화면은 녹음을 다시
   * 물어보며 `state` 가 도는지 본다.
   */
  retranscribe: (id: string) => send<unknown>(`/api/recordings/${enc(id)}/retranscribe`, "POST"),

  // ── 조각(한 줄) ─────────────────────────────────────────
  patchSegment: (id: string, sid: string, patch: { text?: string; speaker?: string | null }) =>
    send<{ segment: SegmentDTO }>(
      `/api/recordings/${enc(id)}/segments/${enc(sid)}`,
      "PATCH",
      patch,
    ).then((j) => j.segment),

  // ── 다듬기 ──────────────────────────────────────────────
  /**
   * 전사문 전체를 에이전트에게 넘겨 다듬는다. 화자도 여기서 추정된다.
   *
   * `context` 는 사람이 적어 주는 한 줄이다 — "무슨 회의인지" 를 알면
   * 화자 추정과 용어 교정이 크게 달라진다.
   */
  polish: (id: string, context?: string) =>
    send<PolishStart>(`/api/recordings/${enc(id)}/polish`, "POST", { context: context ?? "" }),

  // ── 요약 ────────────────────────────────────────────────
  summary: (id: string) => get<SummaryResponse>(`/api/recordings/${enc(id)}/summary`),

  startSummary: (id: string, instruction: string, overwrite: boolean) =>
    send<SummaryResponse>(`/api/recordings/${enc(id)}/summary`, "POST", {
      instruction,
      // 사람이 쓴 요약을 덮을 때만 붙인다. 서버도 같은 것을 본다 — 화면만 믿지 않는다.
      ...(overwrite ? { overwrite: true } : {}),
    }),

  summaryStatus: (id: string, runId: string) =>
    get<SummaryResponse>(`/api/recordings/${enc(id)}/summary?id=${enc(runId)}`),

  /**
   * 사람이 직접 쓴 요약을 저장한다.
   *
   * 계약서에는 `POST …/summary` 하나뿐이라 **몸통으로 갈랐다** — `instruction`
   * 이 오면 에이전트에게 시키는 것, `body` 가 오면 사람이 쓴 글을 그대로
   * 넣는 것. 주소를 하나 더 파지 않은 것은 계약을 지키려는 것이고, 몸통으로
   * 가른 것은 `SummaryDTO.source` 에 이미 `"human"` 이 있어서다 — 사람이 쓴
   * 요약이 있을 자리를 뼈대 쪽도 열어 두었다는 뜻이다.
   */
  saveSummary: (id: string, body: string) =>
    send<SummaryResponse>(`/api/recordings/${enc(id)}/summary`, "POST", { body }),

  // ── 대화 ────────────────────────────────────────────────
  chat: {
    history: (id: string) => get<ChatHistory>(`/api/recordings/${enc(id)}/chat`),

    send: (id: string, message: string) =>
      send<{ id?: string }>(`/api/recordings/${enc(id)}/chat`, "POST", { message }),

    status: (id: string, job: string, signal?: AbortSignal) =>
      get<ChatStatus>(`/api/recordings/${enc(id)}/chat?job=${enc(job)}`, signal),

    reset: (id: string) => send<unknown>(`/api/recordings/${enc(id)}/chat`, "DELETE"),
  },
};

/**
 * 재생할 오디오 주소.
 *
 * **`apiPath()` 를 반드시 통과시킨다.** `<audio src>` 는 Next 가 손대지 않는
 * 손으로 적은 주소라, `/voice` 아래 얹은 배포에서 접두어가 빠지면 도메인
 * 뿌리로 가서 404 를 받고 재생기가 조용히 아무 소리도 안 낸다. 소리가 안 나는
 * 것은 오류로 안 보여서 원인을 찾기가 고약하다.
 *
 * 이 주소는 MemoBento 로 흘려보내는 프록시이고 Range 를 그대로 넘긴다 —
 * 그래서 `<audio>` 의 탐색(seek)이 그대로 된다.
 */
export function audioUrl(recordingId: string): string {
  return apiPath(`/api/recordings/${enc(recordingId)}/audio`);
}
