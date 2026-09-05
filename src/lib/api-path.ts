/**
 * 하위 경로 배포에서 API 주소 앞에 붙일 것.
 *
 * Next 는 `<Link>` 와 `router.push`, 그리고 번들이 아는 자산(`next/image`,
 * import 한 파일)에는 basePath 를 알아서 붙여 준다.
 *
 * **손으로 적은 주소는 손대지 않는다.** `fetch("/api/notebooks")` 도,
 * `<img src="/namu.svg">` 도 그대로 나간다. 그래서 `/mail` 아래에 얹은 앱은
 * 도메인 뿌리로 요청을 보내고 404 를 받는다.
 *
 * 브라우저가 아니라 서버에서 도는 코드에서는 필요 없다 — 라우트 핸들러끼리는
 * 이미 basePath 가 벗겨진 경로로 오간다. 이 함수는 브라우저 쪽에서만 쓴다.
 *
 * 값이 비어 있으면(대부분의 배포) 받은 것을 그대로 돌려준다.
 */

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

export function apiPath(path: string): string {
  if (!BASE) return path;
  // 절대 경로에만 붙인다. 상대 경로나 전체 URL 은 부르는 쪽이 뜻이 있어 쓴 것이다.
  if (!path.startsWith("/")) return path;
  // 두 번 붙는 것을 막는다.
  if (path === BASE || path.startsWith(`${BASE}/`)) return path;
  return `${BASE}${path}`;
}

/**
 * `public/` 아래 파일을 손으로 가리킬 때.
 *
 * 하는 일은 `apiPath` 와 같지만 이름을 나눠 둔다 — 부르는 쪽에서 "이건 API 가
 * 아니라 자산" 임이 보여야, 다음에 `<img src="/…">` 를 쓸 때 여기를 떠올린다.
 * 실제로 `/namu.svg` 가 이 접두어 없이 나가 그림이 통째로 비어 있었다.
 */
export const assetPath = apiPath;

/** `fetch` 를 그대로 쓰되 주소만 고쳐 준다. 호출부는 이름만 바꾸면 된다. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiPath(path), init);
}
