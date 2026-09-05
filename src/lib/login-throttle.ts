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

function keyOf(req: Request): string {
  // 프록시 뒤라면 X-Forwarded-For 가 진짜 주소를 들고 있다. 없으면 하나로 묶는다 —
  // 주소를 못 가르는 상황에서 전부 한 통에 넣는 편이 안전하다.
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? "").trim() || "unknown";
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
