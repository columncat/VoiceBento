import { cookies, headers } from "next/headers";
import { type NextRequest } from "next/server";

import {
  REMEMBER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_TTL_LONG,
  isAuthEnabled,
  logLogin,
  nowSeconds,
  sessionCookieOptions,
} from "@/lib/auth";
import { type SessionPayload, encryptSession, verifySession } from "@/lib/auth-crypto";
import { redirectTo, safePath } from "@/lib/redirect";

/**
 * remember 쿠키로 세션을 조용히 되살린다.
 *
 * 미들웨어는 edge 라 DB 를 못 쓴다. 그래서 "자동 로그인이 있었다" 를 기록하는
 * 일만 여기로 넘어온다. 미들웨어가 화면 이동을 이 주소로 돌리고, 여기서 쿠키를
 * 새로 발급한 뒤 원래 가려던 자리로 돌려보낸다.
 *
 * `to` 는 반드시 `safePath` 를 통과시킨다 — 남이 만든 링크로 열린 자동 갱신이
 * 바깥 주소로 튕겨 나가는 길(오픈 리다이렉트)을 막는다.
 */

export async function GET(req: NextRequest) {
  if (!isAuthEnabled()) {
    return redirectTo("/");
  }

  const cookieStore = await cookies();
  const rememberToken = cookieStore.get(REMEMBER_COOKIE_NAME)?.value;
  if (!rememberToken) {
    return redirectTo("/login");
  }

  const verified = await verifySession(rememberToken);
  if (!verified) {
    return redirectTo("/login");
  }

  const ua = (await headers()).get("user-agent") ?? "unknown";
  try {
    await logLogin({ type: "auto", success: true, userAgent: ua });
  } catch {
    /* 로그 실패해도 로그인 자체는 진행 */
  }

  const now = nowSeconds();
  const payload: SessionPayload = {
    iat: now,
    exp: now + SESSION_TTL_LONG,
    remember: true,
  };
  cookieStore.set(SESSION_COOKIE_NAME, await encryptSession(payload), sessionCookieOptions(true));

  const to = req.nextUrl.searchParams.get("to") || "/";
  return redirectTo(safePath(to));
}
