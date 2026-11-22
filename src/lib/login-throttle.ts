/**
 * 로그인 시도 제한.
 *
 * `/api/login` 은 폼이 아니라 JSON 입구라 스크립트로 두드리기 쉽다. 실패마다
 * 700ms 를 재우는 것만으로는 부족하다 — **동시에** 던지면 지연이 겹쳐서 사라진다.
 * 초당 수백 번이 가능해지고, 그러면 짧은 비밀번호는 금방 뚫린다.
 *
 * 그래서 지연이 아니라 **횟수**로 막는다. 창 안에서 정해진 횟수를 넘기면 그
 * 창이 끝날 때까지 전부 거절한다. 동시 요청도 같은 카운터를 지나므로 병렬로
 * 우회할 수 없다.
 *
 * 프로세스 메모리에 둔다. 단일 컨테이너이고, 재시작하면 풀리는 편이 잠금에
 * 갇히는 것보다 낫다 — 이건 한 사람이 쓰는 앱이다.
 */

/** 창 길이. */
const WINDOW_MS = 10 * 60 * 1000;
/** 창 안에서 허용할 실패 횟수. */
const MAX_FAILS = 10;

interface Bucket {
  fails: number;
  /** 창이 끝나는 시각. */
  until: number;
}

const buckets = new Map<string, Bucket>();

/**
 * 시도를 누구 것으로 셀지.
 *
 * 예전에는 X-Forwarded-For 의 **첫** 항목을 썼다. 그 자리는 클라이언트가 직접
 * 적는다 — Cloudflare 는 들어온 XFF 를 지우지 않고 뒤에 덧붙일 뿐이라,
 * 요청마다 첫 항목을 바꿔 보내면 매번 새 통을 받아 횟수 제한이 없는 것과 같았다.
 *
 * 그래서 믿을 수 있는 순서로 본다.
 *  1. `cf-connecting-ip` — Cloudflare 가 **덮어쓰는** 머리글이다. 클라이언트가
 *     같은 이름으로 보내도 엣지에서 바뀐다. 포트가 loopback 에만 묶인 뒤로는
 *     이 앱에 닿는 것은 cloudflared 뿐이라 이 값이 곧 진짜 주소다.
 *  2. `x-real-ip` — 다른 앞단(nginx 등)에 얹는 배포용.
 *  3. X-Forwarded-For 의 **마지막** 항목 — 바로 앞 프록시가 붙인 것이다.
 *     첫 항목과 달리 클라이언트가 고를 수 없다.
 *  4. 아무것도 없으면 하나로 묶는다 — 주소를 못 가르는 상황에서는 전부 한
 *     통에 넣는 편이 안전하다 (도커 망 안의 MCP 같은 기계 클라이언트).
 */
function keyOf(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for");
  const last = fwd?.split(",").pop()?.trim();
  return last || "unknown";
}

/** 지금 이 요청을 받아도 되는지. 막혔으면 남은 초. */
export function checkLoginAllowed(req: Request): { ok: true } | { ok: false; retryAfter: number } {
  const b = buckets.get(keyOf(req));
  if (!b) return { ok: true };
  if (Date.now() >= b.until) {
    buckets.delete(keyOf(req));
    return { ok: true };
  }
  if (b.fails < MAX_FAILS) return { ok: true };
  return { ok: false, retryAfter: Math.ceil((b.until - Date.now()) / 1000) };
}

export function noteLoginFailure(req: Request): void {
  const k = keyOf(req);
  const now = Date.now();
  const b = buckets.get(k);
  if (!b || now >= b.until) {
    buckets.set(k, { fails: 1, until: now + WINDOW_MS });
    return;
  }
  b.fails += 1;
}

/** 성공하면 창을 지운다. 옳은 비밀번호를 아는 쪽을 계속 막을 이유가 없다. */
export function noteLoginSuccess(req: Request): void {
  buckets.delete(keyOf(req));
}
