/**
 * 하위 경로에 얹을 때 쓰는 값.
 *
 * `bento.example.com/voice` 처럼 도메인 하나를 나눠 쓰는 배포에서 필요하다.
 * 앞단에서 경로만 갈라 보내면 앱은 자기가 `/voice` 아래 있다는 것을 모르고
 * `/recordings/…` 같은 절대 경로를 만들어 낸다 — 브라우저는 그걸 도메인
 * 뿌리로 해석해서 엉뚱한 곳으로 간다.
 *
 * **빌드 시점에 박히는 값이다.** 이미지를 만들 때 정해야 하고 나중에
 * 환경변수로 바꿀 수 없다. Next 가 이 값을 산출물 곳곳(정적 자산 주소,
 * 라우트 표, 클라이언트 번들)에 미리 심기 때문이다.
 *
 * 비워 두면 뿌리에서 돈다. 하위 도메인을 쓰는 배포는 건드릴 필요가 없다.
 */
const basePath = (process.env.BASE_PATH ?? "").replace(/\/$/, "");

/**
 * 모든 응답에 붙이는 보안 머리글.
 *
 * HSTS 는 여기 없다 — Cloudflare 가 붙인다. 여기서 또 붙이면 LAN·로컬에서
 * http 로 열 때 브라우저가 https 를 고집해 화면이 안 뜬다.
 *
 * CSP 가 열어 두는 것과 그 까닭:
 *  - script-src 'unsafe-inline' — App Router 의 flight 자료(`self.__next_f.push`)와
 *    `layout.tsx` 의 THEME_BOOT 가 인라인 스크립트다. 막으면 화면이 하얗게 빈다.
 *    nonce 로 가려면 모든 화면이 동적 렌더가 되어야 해서 하지 않았다.
 *    'unsafe-eval' 은 `next dev` 에서만(HMR 이 eval 을 쓴다). 운영 빌드에는 없다.
 *  - style-src 'unsafe-inline' — React 의 style 속성과 Next 가 심는 <style>.
 *  - cdn.jsdelivr.net — Pretendard 글꼴 CSS 와 그 woff2 (`layout.tsx`).
 *  - fonts.googleapis.com / fonts.gstatic.com — 나머지 글꼴 CSS 와 파일.
 *  - media-src blob: — `<audio>` 는 자기 API 를 직접 부르지만, 브라우저가
 *    소리를 blob 으로 다루는 경우를 막지 않으려고 둔다.
 *  - object-src 'none' — 이 앱에는 <object>/<embed> 가 없다.
 *  - frame-ancestors 'self' — 남의 사이트가 이 화면을 액자에 넣어 누르게 하는
 *    클릭재킹을 막는다. X-Frame-Options 는 그걸 모르는 옛 브라우저용.
 *
 * 마이크는 쓰지 않는다. 녹음은 다른 기기에서 하고 파일로 올린다 — 그래서
 * Permissions-Policy 가 마이크까지 막는다. 브라우저 녹음을 넣는 날 여기를 연다.
 */
const isDev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  /*
   * 번들에 말아 넣지 않고 런타임에 require 로 두는 것.
   *
   * better-sqlite3 는 네이티브 애드온이라 번들러가 손대면 .node 를 못 찾는다.
   *
   * **sherpa-onnx-node 는 여기 없다.** ASR 은 Next 서버가 아니라 자식
   * 프로세스에서 돈다 — 이 바인딩의 C++ 예외는 N-API 를 넘으며
   * `std::terminate()` 를 불러 `try/catch` 로도 못 잡고 앱을 통째로 죽인다.
   * 번들에 들어올 일이 없으니 external 목록에 적을 것도 없다.
   */
  serverExternalPackages: ["better-sqlite3"],
  ...(basePath ? { basePath } : {}),
  /*
   * `source` 에는 basePath 가 저절로 붙는다(`/voice/:path*`). 그 꼴은 접두어
   * 자체(`/voice`)도 잡는다 — 첫 화면에도 머리글이 붙는 것을 확인했다.
   * 라우트가 제 CSP 를 따로 다는 곳은 지금 없다. 생기면 그 경로를 여기서 빼라 —
   * CSP 머리글이 둘이면 브라우저는 **둘 다** 만족해야 해서 더 좁은 쪽이 이긴다.
   */
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  /* `X-Powered-By: Next.js` — 무엇으로 만들었는지 밖에 알릴 까닭이 없다. */
  poweredByHeader: false,
  env: {
    /*
     * 브라우저 코드에도 알려 준다.
     *
     * Next 는 <Link> 와 router 와 정적 자산에는 접두어를 알아서 붙이지만
     * **fetch 는 손대지 않는다.** `fetch("/api/…")` 는 도메인 뿌리로 가서
     * 404 를 받는다. `<audio src>` 도 마찬가지다. 그래서 부를 때 직접
     * 붙여야 하고, 그러려면 값이 필요하다 — `src/lib/api-path.ts`.
     */
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
