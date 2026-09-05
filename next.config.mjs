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
