import { NextResponse, type NextRequest } from "next/server";

import { verifySession } from "@/lib/auth-crypto";

/**
 * Edge-runtime 미들웨어 — DB 접근 X, bcrypt X.
 * 세션 쿠키 검증만 수행. auto-login 등 DB 기록은 /api/auth/auto-renew 에서 처리.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/api/login",
  "/api/auth/auto-renew",
  "/_next",
  "/favicon",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/**
 * 이 요청이 화면 이동인가, 코드가 부르는 것인가.
 *
 * 브라우저의 `fetch` 는 리다이렉트를 **알아서 따라간다.** 그래서 세션이 끊긴
 * 뒤 `/api/…` 를 부르면 로그인 페이지 HTML 이 200 으로 도착하고, 받는 쪽은
 * 그걸 JSON 으로 읽다가 터진다:
 *
 *   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * 화면에는 로그인하라는 말 대신 저 문장이 뜬다. 그래서 API 에는 리다이렉트를
 * 주지 않는다. 401 과 JSON 을 준다.
 *
 * 이 앱에는 그 위에 하나가 더 있다 — **`<audio>` 는 아예 아무 말도 안 한다.**
 * 재생 주소(`/api/recordings/…/audio`)가 로그인 HTML 을 받으면 재생기는
 * 조용히 멈추고 화면에는 아무것도 안 뜬다. 401 을 받으면 적어도 `error`
 * 이벤트가 나서 화면이 "로그인이 풀렸습니다" 를 말할 수 있다.
 */
function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function unauthorized() {
  return NextResponse.json(
    { error: "로그인이 필요합니다", code: "unauthenticated" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export async function middleware(req: NextRequest) {
  // 인증 비활성 → 통과
  if (!process.env.AUTH_PASSWORD) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const sessionToken = req.cookies.get("mb_session")?.value;
  if (sessionToken) {
    const session = await verifySession(sessionToken);
    if (session) return NextResponse.next();
  }

  /*
   * 보낼 곳은 `nextUrl` 을 복사해 만든다.
   *
   * `new URL("/login", req.url)` 로 만들면 하위 경로 배포에서 접두어가 빠진다.
   * `req.url` 은 `https://…/voice/settings` 인데 절대 경로를 얹으면 그 앞이
   * 통째로 지워져 `https://…/login` 이 되고, 그 자리에는 아무것도 없다.
   * `nextUrl` 은 자기가 어느 접두어 아래 있는지 알고 있어서 다시 붙여 준다.
   */
  const to = (path: string, params?: Record<string, string>) => {
    const url = req.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return url;
  };

  // 화면 이동이면 갱신을 거쳐 원래 자리로 돌려보낸다. API 는 그럴 수 없다 —
  // 리다이렉트를 따라간 fetch 는 갱신 라우트가 마지막에 내보내는 HTML 을
  // 받아 들고 JSON 인 줄 알고 읽는다. 401 을 주고 화면이 다시 부르게 한다.
  const rememberToken = req.cookies.get("mb_remember")?.value;
  if (rememberToken) {
    const remember = await verifySession(rememberToken);
    if (remember) {
      if (isApi(pathname)) return unauthorized();
      return NextResponse.redirect(
        to("/api/auth/auto-renew", { to: pathname + req.nextUrl.search }),
      );
    }
  }

  if (isApi(pathname)) return unauthorized();

  return NextResponse.redirect(
    to("/login", pathname === "/" ? undefined : { from: pathname + req.nextUrl.search }),
  );
}

export const config = {
  /*
   * 확장자 제외를 넣지 않는다.
   *
   * 부정 전방탐색 안의 `.*\.(?:png|…)` 에는 끝 앵커가 없어서 확장자가 경로
   * **어디에** 있어도 걸린다. `/api/…/5.png` 같은 요청이 미들웨어를 통째로
   * 건너뛰고, 라우트는 `id="5.png"` 로 그대로 매치된다 — 로그인 없이 API 가
   * 열린다. 앵커를 붙여도 끝에 `.png` 를 달면 그만이라 소용없다.
   * 이 앱은 파일 이름이 `회의.mp4` 꼴로 오가는 자리가 많아 더 그렇다.
   *
   * 정적 자산은 아래 PUBLIC_PREFIXES 의 "/_next" · "/favicon" 이 이미
   * 통과시키므로 여기서 뺄 이유가 없다.
   */
  /*
   * 첫 화면("/")을 따로 적는다.
   *
   * 하위 경로 배포에서 Next 는 이 패턴 앞에 접두어를 붙여 `/voice/((?!…).*)`
   * 로 만든다. 그러면 `/voice/settings` 는 걸리는데 **`/voice` 자체는 뒤에
   * 슬래시가 없어 안 걸린다.** 첫 화면이 미들웨어를 통째로 건너뛰어 로그인
   * 없이 열렸다 (PaperBento 에서 실제로 그랬다).
   */
  matcher: ["/", "/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
