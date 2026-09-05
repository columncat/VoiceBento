import { env } from "./env";

/**
 * MemoBento — 이 앱의 **파일 저장소**.
 *
 * VoiceBento 는 바이트를 제 디스크에 두지 않는다. 올라온 조각을 그대로
 * MemoBento 의 예약 메모함으로 흘려보내고 `fileId` 만 받아 적는다. 재생도
 * 그쪽 파일 라우트로 프록시하고(Range 를 그대로 실어서), 다시 전사할 때도
 * 그쪽에서 받아 온다.
 *
 * 왜 그렇게 했나. 저장소를 둘로 나누면 "파일은 지웠는데 행이 남은" 자리와
 * "행은 지웠는데 파일이 남은" 자리가 반드시 생긴다. 손잡이가 하나면 그런
 * 어긋남 자체가 없다. 그리고 사람이 올린 소리는 전사문보다 오래 남을 것이라
 * 이미 파일을 돌보는 앱에 두는 편이 맞다.
 */

const AGENT_HEADER = "x-mb-agent";

/**
 * 주소를 잇는다.
 *
 * `new URL("/api/…", base)` 를 쓰면 안 된다. 앞이 `/` 인 경로는 **절대 경로**라
 * base 의 경로 부분을 통째로 버린다 — `https://bento.example.com/memo` 에
 * 이으면 `https://bento.example.com/api/…` 가 되어 404 다.
 *
 * BentoAgent 와 MemoBento MCP 가 같은 것을 이미 두 번 겪었다. 둘 다 실패하면
 * 빈 값을 돌려주는 자리라 아무 소리도 나지 않고 **조용히 멈춰 있었다.**
 * 그래서 이 앱에서는 실패를 삼키지 않는다 — 아래 `call()` 은 던진다.
 */
export function join(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export class MemoBentoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MemoBentoError";
  }
}

/**
 * **서버가** 부를 주소.
 *
 * `MEMOBENTO_API_URL`(컨테이너끼리 닿는 주소)이 있으면 그것을, 없으면
 * `MEMOBENTO_URL`(사람이 누르는 바깥 주소)을 쓴다. 왜 갈라 두는지는
 * `lib/env.ts` 의 `MEMOBENTO_API_URL` 설명에 적어 두었다 — 요약하면, 바깥
 * 주소로 파일을 주고받으면 요청이 터널을 한 바퀴 돌아 나갔다 들어오면서
 * 100MB 한계와 Access 로그인 화면을 만난다.
 */
function apiUrl(): string | undefined {
  return env.MEMOBENTO_API_URL?.trim() || env.MEMOBENTO_URL?.trim() || undefined;
}

/** 설정이 됐는가. 안 됐으면 왜인지 문장으로. */
export function memobentoReady(): { ready: boolean; reason: string | null } {
  if (!apiUrl()) {
    return {
      ready: false,
      reason:
        "MemoBento 주소(MEMOBENTO_API_URL 또는 MEMOBENTO_URL)가 없습니다. " +
        "올린 파일이 갈 곳이 없어 올리기와 재생이 모두 멈춥니다.",
    };
  }
  return { ready: true, reason: null };
}

function baseUrl(): string {
  const url = apiUrl();
  if (!url) throw new MemoBentoError(memobentoReady().reason!);
  return url;
}

/*
 * 쿠키 한 벌을 모듈 전역에 둔다.
 *
 * 프로세스 하나가 MemoBento 에 하나의 신분으로 붙는다. 요청마다 로그인하면
 * MemoBento 의 로그인 기록이 우리 요청으로 뒤덮이고, 그쪽의 시도 제한
 * (`login-throttle`)에도 걸린다.
 */
let cookie: string | null = null;

function absorb(res: Response): void {
  const raw =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);
  if (raw.length === 0) return;

  const jar = new Map<string, string>();
  if (cookie) {
    for (const part of cookie.split("; ")) {
      const i = part.indexOf("=");
      if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
    }
  }
  for (const line of raw) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ") || null;
}

interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** 큰 파일을 흘려보낼 때는 시간이 걸린다. 기본은 짧게. */
  timeoutMs?: number;
  /** 스트림 본문을 보낼 때 필요하다 (Node 의 fetch 규약). */
  duplex?: "half";
}

async function rawCall(path: string, init: CallInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 20_000);
  try {
    return await fetch(join(baseUrl(), path), {
      method: init.method ?? "GET",
      // 로그인 화면으로 튕긴 것을 200 으로 오해하지 않게. 우리는 직접 로그인한다.
      redirect: "manual",
      headers: {
        accept: "application/json",
        [AGENT_HEADER]: "VoiceBento",
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body ?? undefined,
      signal: ctl.signal,
      ...(init.duplex ? ({ duplex: init.duplex } as Record<string, unknown>) : {}),
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new MemoBentoError(
      aborted
        ? `MemoBento 가 제 시간에 답하지 않았습니다 (${path})`
        : `MemoBento 에 닿지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function login(): Promise<void> {
  if (!env.MEMOBENTO_PASSWORD) return; // 인증이 꺼진 배포
  const res = await rawCall("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: env.MEMOBENTO_PASSWORD, remember: true }),
  });
  absorb(res);
  if (!res.ok) {
    cookie = null;
    throw new MemoBentoError(
      `MemoBento 로그인에 실패했습니다 (${res.status}). MEMOBENTO_PASSWORD 를 확인하세요.`,
      res.status,
    );
  }
}

/** 인증에 튕기면 한 번 로그인하고 다시. 몸통이 스트림이면 다시 보낼 수 없다. */
async function call(
  path: string,
  init: CallInit = {},
  opts: { retryable?: boolean } = { retryable: true },
): Promise<Response> {
  let res = await rawCall(path, init);
  const needsLogin = res.status === 401 || (res.status >= 300 && res.status < 400);
  if (needsLogin && opts.retryable !== false) {
    await login();
    res = await rawCall(path, init);
  }
  absorb(res);
  return res;
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      /* 그대로 */
    }
    throw new MemoBentoError(`${what} 실패 (${res.status}): ${detail}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MemoBentoError(`${what}: MemoBento 응답을 읽지 못했습니다`);
  }
}

// ─────────────────────────────────────────────────────────────
//   메모함 찾기
// ─────────────────────────────────────────────────────────────

interface NotebookLite {
  id: string;
  name: string;
  systemKey: string | null;
  accepts?: string[];
}

/**
 * 찾은 메모함 id 를 잠깐 기억한다.
 *
 * `/api/notebooks` 는 **모든 메모함의 모든 메모**를 실어 온다. 파일 하나
 * 올릴 때마다 그걸 받아 올 이유가 없다.
 */
let notebookCache: { id: string; at: number } | null = null;
const NOTEBOOK_TTL_MS = 5 * 60_000;

/**
 * 파일을 넣을 메모함 id.
 *
 * 환경변수에 적혀 있으면 그것이 이긴다. 없으면 `system_key` 로 찾는다 —
 * 예약 메모함을 만드는 일은 **배포 담당이 MemoBento 쪽에서** 한다
 * (`SYSTEM_KEYS` 에 키를 더하고 `SYSTEM_NOTEBOOKS` 에 한 줄). 그 전까지는
 * 여기서 못 찾으므로, 무엇이 빠졌는지 그대로 말한다.
 */
export async function resolveNotebookId(): Promise<string> {
  if (env.MEMOBENTO_NOTEBOOK_ID) return env.MEMOBENTO_NOTEBOOK_ID;

  if (notebookCache && Date.now() - notebookCache.at < NOTEBOOK_TTL_MS) {
    return notebookCache.id;
  }

  const res = await call("/api/notebooks");
  const body = await json<{ notebooks?: NotebookLite[] }>(res, "메모함 목록");
  const key = env.MEMOBENTO_NOTEBOOK_KEY;
  const found = (body.notebooks ?? []).find((n) => n.systemKey === key);
  if (!found) {
    throw new MemoBentoError(
      `MemoBento 에 system_key="${key}" 인 메모함이 없습니다. ` +
        `MemoBento 의 SYSTEM_KEYS / SYSTEM_NOTEBOOKS 에 그 자리를 만들어야 합니다. ` +
        `그 전까지는 MEMOBENTO_NOTEBOOK_ID 로 기존 메모함 id 를 직접 지정할 수 있습니다.`,
    );
  }
  notebookCache = { id: found.id, at: Date.now() };
  return found.id;
}

// ─────────────────────────────────────────────────────────────
//   올리기 — 조각을 그대로 흘려보낸다
// ─────────────────────────────────────────────────────────────

/**
 * 조각 크기. **MemoBento 의 `PLAIN_CHUNK` 와 같아야 한다.**
 *
 * 그쪽은 조각 번호에 이 크기를 곱해 오프셋을 잡는다. 값이 어긋나면 파일이
 * 조용히 깨진 채로 저장된다 — 오류도 안 나고 크기 검사도 통과한다
 * (마지막 조각만 짧아서 총합이 맞기 때문이다). 브라우저 → 이 앱 → MemoBento
 * 세 자리가 모두 이 값을 쓴다.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface MemoBentoUpload {
  uploadId: string;
  chunkSize: number;
  chunks: number;
}

/** 올릴 자리를 잡는다. 여기서 거절당하면 조각을 한 번도 안 보낸 상태다. */
export async function beginUpload(input: {
  name: string;
  size: number;
}): Promise<MemoBentoUpload> {
  const notebookId = await resolveNotebookId();
  const res = await call("/api/upload/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notebookId, name: input.name, size: input.size }),
  });
  const body = await json<MemoBentoUpload>(res, "올리기 시작");
  if (body.chunkSize !== CHUNK_SIZE) {
    /*
     * 조각 크기가 다르면 그 자리에서 멈춘다.
     *
     * 브라우저가 이미 우리 `chunkSize` 로 잘라 보내고 있는데 저쪽이 다른
     * 크기로 오프셋을 잡으면 파일이 깨진다. 그런데 크기 검사는 통과한다 —
     * 조용히 깨진 파일보다 여기서 멈추는 편이 낫다.
     */
    throw new MemoBentoError(
      `MemoBento 의 조각 크기가 ${body.chunkSize} 인데 이 앱은 ${CHUNK_SIZE} 로 자릅니다. ` +
        `두 값이 어긋나면 파일이 조용히 깨집니다 — 양쪽 PLAIN_CHUNK / CHUNK_SIZE 를 맞추세요.`,
    );
  }
  return body;
}

/** 조각 하나 전달. 몸통은 손대지 않고 그대로 흘려보낸다. */
export async function putChunk(
  uploadId: string,
  index: number,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  /*
   * 로그인 재시도를 끄지 않는다 — 몸통이 버퍼라 다시 보낼 수 있다.
   * (스트림이었다면 한 번 읽고 나면 되돌릴 수 없어 재시도가 거짓말이 된다.)
   */
  const res = await call(
    `/api/upload/chunk?id=${encodeURIComponent(uploadId)}&index=${index}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes as BodyInit,
      timeoutMs: 120_000,
    },
  );
  await json<{ ok: boolean }>(res, `조각 ${index} 보내기`);
}

/** 다 보냈으면 확정. 파일 id 를 받는다. */
export async function finishUpload(uploadId: string): Promise<string> {
  const res = await call("/api/upload/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId }),
    timeoutMs: 60_000,
  });
  const body = await json<{ fileId?: string }>(res, "올리기 확정");
  if (!body.fileId) {
    throw new MemoBentoError("MemoBento 가 파일 id 를 주지 않았습니다");
  }
  return body.fileId;
}

/** 반쯤 올리다 만 것 치우기. 실패해도 조용히 넘어간다 — 정리일 뿐이다. */
export async function cancelUpload(uploadId: string): Promise<void> {
  try {
    await call(`/api/upload/finish?id=${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
    });
  } catch {
    /* 저쪽 임시 파일은 저쪽이 알아서 정리한다 */
  }
}

// ─────────────────────────────────────────────────────────────
//   읽기 — 재생 프록시와 전사 재료
// ─────────────────────────────────────────────────────────────

/**
 * 파일 바이트를 연다. **Range 헤더를 그대로 실어 보낸다.**
 *
 * 재생 프록시가 이걸 쓴다. `<audio>` 의 탐색은 Range 로 이루어지고, MemoBento
 * 의 파일 라우트는 206 과 `Content-Range` 를 제대로 준다 — 우리가 할 일은
 * 중간에서 그 대화를 망치지 않는 것뿐이다. 그래서 몸통을 읽지 않고
 * `res.body` 를 그대로 넘긴다 (버퍼에 담으면 한 시간짜리 영상이 메모리에
 * 통째로 올라온다).
 *
 * `login` 재시도가 있으므로 세션이 끊긴 채로 첫 재생을 눌러도 한 번 만에 붙는다.
 */
export async function openFile(
  fileId: string,
  range: string | null,
): Promise<Response> {
  return call(
    `/api/files/${encodeURIComponent(fileId)}`,
    {
      headers: {
        accept: "*/*",
        ...(range ? { range } : {}),
      },
      // 한 시간짜리 영상을 통째로 받아 오는 자리이기도 하다 (전사 재료).
      timeoutMs: 30 * 60_000,
    },
  );
}

/*
 * 지우기는 여기 없다. **일부러다.**
 *
 * MemoBento 에는 "파일만 지우기" 입구가 없다 — 파일은 메모에 딸려 있고,
 * 메모를 지우는 것은 그 메모함을 보는 사람의 일이다. 그래서 이 앱에서 녹음을
 * 지워도 소리는 메모함에 남는다. 전사문이 마음에 안 들어 지운 것과 원본을
 * 버리겠다는 것은 다른 뜻이고, 되돌릴 수 없는 쪽으로 기울지 않는 편이 낫다.
 * (`DELETE /api/recordings/[id]` 도 같은 말을 응답에 실어 보낸다.)
 */
