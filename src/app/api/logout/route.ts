import { cookies } from "next/headers";

import { REMEMBER_COOKIE_NAME, SESSION_COOKIE_NAME } from "@/lib/auth";
import { redirectTo } from "@/lib/redirect";

/**
 * 로그아웃. 쿠키 둘을 지우고 로그인 화면으로 보낸다.
 *
 * GET 도 받는 이유는 주소창에 쳐서 나갈 수 있어야 하기 때문이다 — 화면이
 * 이상해져서 버튼을 못 누를 때 쓰는 비상구다.
 */

async function clearCookiesAndRedirect() {
  const c = await cookies();
  c.delete(SESSION_COOKIE_NAME);
  c.delete(REMEMBER_COOKIE_NAME);
  // 303 — 로그아웃 뒤에는 무슨 메서드로 들어왔든 /login 을 GET 해야 한다
  return redirectTo("/login", 303);
}

export async function POST() {
  return clearCookiesAndRedirect();
}

export async function GET() {
  return clearCookiesAndRedirect();
}
