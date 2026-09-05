"use client";

import { ArrowUpRight, AudioLines, BookMarked, Mail, StickyNote } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * 형제 앱 주소 유추.
 *
 * 접속 경로에 따라 정답이 다르다:
 *   - `voicebento.columncat.cc` 처럼 서브도메인으로 들어왔으면 → 형제 서브도메인.
 *     도메인에는 앱 포트가 열려 있지 않으므로 포트를 붙이면 깨진다.
 *   - LAN IP / Tailscale IP / MagicDNS 로 들어왔으면 → 같은 호스트의 다른 포트.
 *
 * 덕분에 들어온 경로를 그대로 따라간다. 서버가 `href`(환경변수 override)를 주면
 * 그 값이 항상 이긴다.
 *
 * **한 도메인을 경로로 나눠 쓰는 배포는 유추로 못 맞힌다.** `bento.example.com/voice`
 * 에서 `/memo` 로 가야 하는데, 여기서는 호스트만 보고 경로를 모른다. 그런
 * 배포에서는 환경변수로 전체 주소를 주어야 한다 — 그래서 `href` 가 늘 이긴다.
 * 지금 배포가 바로 그 모양이라(`bento.columncat.cc/mail|/memo|/paper|/voice`)
 * 이 앱에서는 사실상 늘 `href` 가 쓰인다.
 */
export function siblingAppUrl(
  self: string,
  sibling: string,
  defaultPort: number,
): string {
  const { protocol, hostname } = window.location;
  const parts = hostname.split(".");
  if (parts.length >= 3 && parts[0].toLowerCase() === self) {
    return `${protocol}//${[sibling, ...parts.slice(1)].join(".")}`;
  }
  return `${protocol}//${hostname}:${defaultPort}`;
}

/** 이 앱이 무엇인지. 유추할 때 자기 서브도메인 이름으로도 쓴다. */
const SELF = "voicebento";

/**
 * 아이콘은 형제 앱들이 이미 쓰던 것을 그대로 가져왔다 (`MemoBento`·`MailBento`·
 * `PaperBento` 의 같은 파일). 네 앱을 오가는 사람에게 같은 앱이 자리마다 다른
 * 그림으로 보이면 그것만으로 길을 잃는다. 다섯째인 이 앱만 새로 고른다.
 */
const APPS = {
  mailbento: { label: "MailBento", icon: Mail, port: 3000 },
  memobento: { label: "MemoBento", icon: StickyNote, port: 3001 },
  paperbento: { label: "PaperBento", icon: BookMarked, port: 3002 },
  voicebento: { label: "VoiceBento", icon: AudioLines, port: 3003 },
} as const;

export type AppKey = keyof typeof APPS;

/**
 * 형제 앱으로 건너가는 버튼.
 *
 * 앱마다 따로 만들지 않고 하나로 둔다. 앱이 셋이 되면서 같은 모양의 컴포넌트가
 * 앱마다 둘씩 생길 판이었다 — 다섯이 된 지금은 여덟이 됐을 것이다.
 */
export function CrossAppLink({
  app,
  href,
}: {
  app: AppKey;
  href?: string | null;
}) {
  const meta = APPS[app];
  const [url, setUrl] = useState(href ?? "");

  useEffect(() => {
    if (href) {
      setUrl(href);
      return;
    }
    setUrl(siblingAppUrl(SELF, app, meta.port));
  }, [href, app, meta.port]);

  const Icon = meta.icon;
  return (
    <a
      href={url || "#"}
      className="group flex items-center gap-2 rounded-full bg-(--color-surface) px-4 py-2 text-sm text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-2)"
      title={url ? `${meta.label} 로 이동 (${url})` : `${meta.label} 로 이동`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{meta.label}</span>
      <ArrowUpRight className="h-3 w-3 text-(--color-fg-4) transition group-hover:text-(--color-fg-2)" />
    </a>
  );
}
