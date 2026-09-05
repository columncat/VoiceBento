/**
 * Node runtime 전용 인증 유틸 — DB / bcryptjs 사용.
 * 미들웨어에서 직접 import 하지 말 것 (edge 호환 안 됨).
 * 쿠키 crypto 는 lib/auth-crypto.ts 에 분리되어 있음 (edge 호환).
 */

import bcrypt from "bcryptjs";

import { db, schema } from "./db";
import { env } from "./env";

export function isAuthEnabled(): boolean {
  return !!env.AUTH_PASSWORD;
}

/** Plaintext 와 bcrypt 해시 둘 다 자동 감지. timing-safe 비교. */
export function verifyPassword(input: string): boolean {
  const stored = env.AUTH_PASSWORD;
  if (!stored) return false;

  if (
    stored.startsWith("$2a$") ||
    stored.startsWith("$2b$") ||
    stored.startsWith("$2y$")
  ) {
    try {
      return bcrypt.compareSync(input, stored);
    } catch {
      return false;
    }
  }

  if (input.length !== stored.length) return false;
  let mismatch = 0;
  for (let i = 0; i < stored.length; i++) {
    mismatch |= input.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return mismatch === 0;
}

/** 로그인 기록 한 줄 추가. DELETE 엔드포인트는 의도적으로 없음. */
export async function logLogin(opts: {
  type: "manual" | "auto";
  success: boolean;
  userAgent: string;
}): Promise<void> {
  await db
    .insert(schema.loginLog)
    .values({
      type: opts.type,
      success: opts.success ? 1 : 0,
      userAgent: opts.userAgent.slice(0, 500),
    })
    .run();
}

// ─────────────────────────────────────────────────────────────
//   세션 / remember 쿠키 정책
// ─────────────────────────────────────────────────────────────

/*
 * 쿠키 이름을 **네 앱이 함께 쓴다.** 일부러 그렇다.
 *
 * 한 도메인에 `/mail`·`/memo`·`/paper`·`/voice` 를 얹으면 쿠키는 경로를 가리지
 * 않으므로 네 앱이 같은 쿠키를 본다. 설치 마법사가 넷에 **같은 `AUTH_SECRET`**
 * 을 넣기 때문에 그 쿠키는 어느 앱에서든 풀린다 — 한 번 로그인하면 다 열린다.
 *
 * 이름을 달리하면 그 공유가 깨진다. 앱을 오갈 때마다 다시 로그인해야 하고,
 * 앱들이 한 벌처럼 보이는 것이 이 스택의 요점이라 그건 손해다.
 *
 * 대신 조건이 하나 붙는다 — **`AUTH_SECRET` 이 넷에서 같아야 한다.** 다르면
 * 공유가 아니라 서로 쫓아내는 것이 된다: 남의 쿠키를 못 풀어 로그인 화면으로
 * 보내고, 거기서 제 쿠키를 같은 이름으로 덮어써 앞 앱의 세션을 끊는다.
 * 마법사를 거치지 않고 손으로 값을 넣을 때 특히 조심할 자리다.
 *
 * `middleware.ts` 도 같은 이름을 문자열로 들고 있다 — 거기는 Edge 런타임이라
 * 이 모듈(DB 를 쓴다)을 import 할 수 없다. 한쪽을 고치면 다른 쪽도.
 */
export const SESSION_COOKIE_NAME = "mb_session";
export const REMEMBER_COOKIE_NAME = "mb_remember";

const HOUR = 3600;
const DAY = 24 * HOUR;

/** "remember" 안 한 경우 세션 유효시간 (browser-close 로도 끊김). */
export const SESSION_TTL_SHORT = 4 * HOUR;
/** "remember" 한 경우 세션 유효시간. */
export const SESSION_TTL_LONG = 24 * HOUR;
/** "remember" 쿠키 자체의 유효시간 — 이게 진짜 "자동 로그인" 기간. */
export const REMEMBER_TTL = 90 * DAY;

export function sessionCookieOptions(remember: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    ...(remember ? { maxAge: SESSION_TTL_LONG } : {}),
  };
}

export function rememberCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: REMEMBER_TTL,
  };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
