import { AudioLines } from "lucide-react";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { isAuthEnabled } from "@/lib/auth";
import { safePath } from "@/lib/redirect";

/**
 * 로그인 화면.
 *
 * 이 자리가 비어 있으면 **앱이 통째로 안 열린다.** 미들웨어는 세션이 없는
 * 요청을 `/login` 으로 보내는데(`middleware.ts` 끝), 그 자리에 아무것도 없으면
 * 404 가 뜬다 — 로그인할 방법이 없으니 되돌아올 길도 없다.
 *
 * 돌아갈 자리(`?from=`)는 반드시 `safePath` 를 지난다. `//evil.com` 은 프로토콜
 * 상대 URL 이라 다른 사이트로 나가고, 브라우저는 역슬래시를 슬래시처럼 읽으므로
 * `/\evil.com` 도 마찬가지다 — 로그인 직후, 가장 믿기 쉬운 순간에 남의 사이트로
 * 보내진다.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  // 인증이 꺼진 배포에서는 이 화면 자체가 뜻이 없다.
  if (!isAuthEnabled()) redirect("/");

  const { from } = await searchParams;
  const to = safePath(from);

  return (
    <main className="relative mx-auto flex min-h-screen max-w-[400px] flex-col items-center justify-center gap-6 px-6 py-10">
      <div className="flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-(--color-surface) ring-1 ring-(--color-border-soft)">
          <AudioLines className="h-6 w-6 text-(--color-accent)" />
        </div>
        <div>
          <h1 className="text-2xl leading-tight" style={{ fontFamily: "var(--font-serif)" }}>
            VoiceBento
          </h1>
          <p className="text-xs text-(--color-fg-4)">음성함 접근에 비밀번호 필요</p>
        </div>
      </div>

      <section className="w-full rounded-[var(--radius-card)] bg-(--color-surface) p-6 ring-1 ring-(--color-border-soft)">
        <LoginForm to={to} />
      </section>
    </main>
  );
}
