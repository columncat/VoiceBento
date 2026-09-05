/**
 * 응답을 JSON 으로 읽되, JSON 이 아닐 때 무슨 일이 있었는지 말해 준다.
 *
 * `res.json()` 을 그냥 부르면 서버가 HTML 을 돌려줬을 때 이런 게 화면에 뜬다.
 *
 *   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * 사용자가 할 수 있는 일이 하나도 담겨 있지 않은 문장이다. 정작 일어난 일은
 * "로그인이 풀렸다" 거나 "앞단이 시간 초과로 끊었다" 인데 그 말이 어디에도
 * 없다.
 *
 * 인증 쪽은 미들웨어가 API 에 401 JSON 을 주도록 고쳐 막았다. 여기서 남는
 * 것은 우리 손 밖의 HTML — Cloudflare 터널의 502·524 오류 페이지, 라우트를
 * 잘못 짚었을 때의 Next 404 — 이다. 그것들을 알아볼 수 있는 말로 바꾼다.
 *
 * `res.ok` 를 **먼저** 본다. 여러 곳이 파싱을 먼저 하고 상태를 나중에 보고
 * 있었는데, 그러면 애써 준비해 둔 안내문이 한 번도 쓰이지 못한다.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 서버가 code 를 실어 줬다면. 세션 만료는 "unauthenticated". */
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** 세션이 풀린 것인가. 화면이 다시 로그인하라고 말할 때 쓴다. */
export function isUnauthenticated(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 401 || e.code === "unauthenticated");
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();

  let parsed: unknown = undefined;
  let parseFailed = false;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  const serverError =
    parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : undefined;
  const serverCode =
    parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string"
      ? (parsed as { code: string }).code
      : undefined;

  if (!res.ok) {
    if (res.status === 401) {
      throw new HttpError(
        serverError ?? "로그인이 풀렸습니다. 새로고침하고 다시 로그인하세요.",
        401,
        serverCode ?? "unauthenticated",
      );
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new HttpError(
        serverError ?? "서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.",
        res.status,
        serverCode,
      );
    }
    throw new HttpError(serverError ?? `요청이 실패했습니다 (${res.status})`, res.status, serverCode);
  }

  if (parseFailed) {
    // 200 인데 HTML 이다. 앞단이 오류 페이지를 200 으로 감싸 보내는 경우가 있다.
    throw new HttpError(
      looksLikeHtml(text)
        ? "서버가 JSON 대신 웹 페이지를 돌려줬습니다. 로그인이 풀렸거나 앞단에서 끊긴 것 같습니다."
        : "서버 응답을 읽지 못했습니다.",
      res.status,
    );
  }

  return parsed as T;
}
