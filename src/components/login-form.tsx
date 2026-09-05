"use client";

import { AlertCircle, Loader2, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiFetch } from "@/lib/api-path";
import { readJson } from "@/lib/read-json";

/**
 * 비밀번호 한 칸.
 *
 * PaperBento 와 같은 모양이다 — 서버 액션이 아니라 `/api/login` 을 부른다.
 * 그 입구는 미들웨어의 공개 목록에 이미 자리가 있고(`PUBLIC_PREFIXES`),
 * 화면과 스크립트가 같은 검사·같은 기록·같은 쿠키·같은 횟수 제한을 쓰게 된다.
 * 입구가 둘이면 잠금 같은 것을 두 곳에서 지켜야 한다.
 *
 * 비밀번호는 상태에 잠깐 담기지만 어디에도 남기지 않는다 — 주소에 실리지
 * 않고(POST 다) 로컬 저장소에도 넣지 않는다.
 */
export function LoginForm({ to }: { to: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    const remember = form.get("remember") === "on";
    if (!password) {
      setError("비밀번호를 입력하세요");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const res = await apiFetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, remember }),
      });
      await readJson<{ ok?: boolean }>(res);
      // 쿠키가 붙은 뒤에야 서버 컴포넌트가 다시 그려져야 한다.
      // `replace` 라 뒤로 가기로 로그인 화면에 되돌아오지 않는다.
      router.replace(to);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-(--color-fg-2)">비밀번호</span>
        <div className="relative">
          <Lock className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-(--color-fg-4)" />
          <input
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-lg bg-(--color-bg-2) py-2.5 pr-3 pl-9 text-sm text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none placeholder:text-(--color-fg-4) focus:ring-(--color-accent)/60"
          />
        </div>
      </label>

      <label className="flex items-center gap-2 text-xs text-(--color-fg-2)">
        <input
          name="remember"
          type="checkbox"
          className="h-3.5 w-3.5 rounded border-(--color-border) bg-(--color-bg-2) text-(--color-accent) focus:ring-(--color-accent)/60"
        />
        <span>이 기기에서 자동 로그인 (90일)</span>
      </label>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-(--color-danger)/10 px-3 py-2.5 text-xs text-(--color-danger) ring-1 ring-(--color-danger)/30">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 flex items-center justify-center gap-2 rounded-full bg-(--color-accent) px-5 py-2.5 text-sm font-medium text-(--color-bg) hover:bg-(--color-accent-strong) disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {pending ? "확인 중…" : "로그인"}
      </button>

      <p className="text-center text-[10.5px] text-(--color-fg-4)">
        모든 로그인 시도는 기록됩니다 (실패 포함).
      </p>
    </form>
  );
}
