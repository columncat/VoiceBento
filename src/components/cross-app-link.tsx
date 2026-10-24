"use client";

import {
  AudioLines,
  BookMarked,
  Check,
  ChevronDown,
  Mail,
  StickyNote,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * 형제 앱 주소 유추.
 *
 * 접속 경로에 따라 정답이 다르다:
 *   - `voicebento.example.com` 처럼 서브도메인으로 들어왔으면 → 형제 서브도메인.
 *     도메인에는 앱 포트가 열려 있지 않으므로 포트를 붙이면 깨진다.
 *   - LAN IP / Tailscale IP / MagicDNS 로 들어왔으면 → 같은 호스트의 다른 포트.
 *
 * 덕분에 들어온 경로를 그대로 따라간다. 서버가 주소(환경변수 override)를 주면
 * 그 값이 항상 이긴다.
 *
 * **한 도메인을 경로로 나눠 쓰는 배포는 유추로 못 맞힌다.** `bento.example.com/voice`
 * 에서 `/memo` 로 가야 하는데, 여기서는 호스트만 보고 경로를 모른다. 그런
 * 배포에서는 환경변수로 전체 주소를 주어야 한다.
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
const SELF: AppKey = "voicebento";

/**
 * 다섯 앱. **순서와 아이콘이 다섯 앱에서 같아야 한다** — 이 파일은 `SELF` 한
 * 줄만 빼고 다섯 저장소에 똑같이 있다. 같은 앱이 자리마다 다른 그림이나 다른
 * 칸에 보이면 그것만으로 길을 잃는다.
 */
const APPS = {
  mailbento: { label: "MailBento", hint: "메일함", icon: Mail, port: 3000 },
  memobento: { label: "MemoBento", hint: "메모함", icon: StickyNote, port: 3001 },
  paperbento: { label: "PaperBento", hint: "논문함", icon: BookMarked, port: 3002 },
  voicebento: { label: "VoiceBento", hint: "음성함", icon: AudioLines, port: 3003 },
  ledgerbento: { label: "LedgerBento", hint: "장부함", icon: Wallet, port: 3004 },
} as const;

export type AppKey = keyof typeof APPS;

/** 서버가 환경변수에서 읽어 넘기는 형제 앱 주소. 비어 있으면 유추한다. */
export type AppUrls = Partial<Record<AppKey, string | null>>;

/**
 * Alt+Q 로 건너가는 짝. **메일함 ↔ 메모함만** 있다 — 가장 자주 오가는 둘이라
 * 손을 키보드에서 떼지 않게 했다. 다른 앱에서는 단축키가 아무 일도 안 한다.
 */
const SHORTCUT: Partial<Record<AppKey, AppKey>> = {
  mailbento: "memobento",
  memobento: "mailbento",
};

/** 입력 중인 자리인가. 여기서 단축키를 누르면 먼저 빠져나와 저장을 기다린다. */
function isEditable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * 진행 중인 쓰기 요청 수.
 *
 * 메모함은 입력칸에서 **빠져나올 때** 저장한다(onBlur). 단축키로 곧장 페이지를
 * 옮기면 그 저장 요청이 떠나기도 전에 브라우저가 끊어서, 방금 친 글이 조용히
 * 사라진다. 그래서 쓰기(GET/HEAD 가 아닌 것)만 세어 두고, 다 끝난 뒤에 옮긴다.
 * 읽기를 세지 않는 것은 채팅창의 폴링 같은 긴 요청이 늘 걸려 있어서다 — 그것까지
 * 기다리면 단축키가 매번 상한까지 멈춘다.
 */
let pendingWrites = 0;
let fetchWrapped = false;

function trackWrites() {
  if (fetchWrapped || typeof window === "undefined") return;
  fetchWrapped = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method === "GET" || method === "HEAD") return orig(input, init);
    pendingWrites++;
    return orig(input, init).finally(() => {
      pendingWrites--;
    });
  };
}

/** 저장이 끝나기를 기다리는 상한. 서버가 멈춰 있어도 단축키는 결국 먹는다. */
const SAVE_WAIT_MS = 3000;

async function leaveTo(url: string) {
  const el = document.activeElement;
  if (isEditable(el)) {
    el.blur();
    // blur 처리기가 저장 요청을 보내는 데 한 박자가 걸린다 (상태를 고친 뒤 보내는 곳이 있다).
    await new Promise((r) => setTimeout(r, 50));
  }
  const until = Date.now() + SAVE_WAIT_MS;
  while (pendingWrites > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
  window.location.href = url;
}

function resolve(urls: AppUrls): Record<AppKey, string> {
  const out = {} as Record<AppKey, string>;
  for (const key of Object.keys(APPS) as AppKey[]) {
    out[key] = urls[key]?.trim() || siblingAppUrl(SELF, key, APPS[key].port);
  }
  return out;
}

/**
 * 앱 사이를 건너가는 드롭다운. 머리글에 하나만 둔다.
 *
 * 예전에는 앱마다 형제 버튼을 따로 늘어놓았는데, 앱마다 보이는 형제가 달랐다
 * (장부함에서는 메일·메모만, 음성함으로 가는 버튼은 음성함에만). 다섯 앱이
 * 같은 목록을 같은 순서로 보이게 하려고 하나로 모았다.
 *
 * 주소는 브라우저에서 정한다. 유추가 `window.location` 을 봐야 해서다.
 */
export function AppSwitcher({ urls }: { urls: AppUrls }) {
  const [resolved, setResolved] = useState<Record<AppKey, string> | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 객체를 그대로 의존성에 두면 부모가 다시 그릴 때마다 돈다.
  const urlsKey = JSON.stringify(urls);
  useEffect(() => {
    setResolved(resolve(JSON.parse(urlsKey) as AppUrls));
  }, [urlsKey]);

  const pair = SHORTCUT[SELF];

  useEffect(trackWrites, []);

  useEffect(() => {
    if (!pair || !resolved) return;
    const onKey = (e: KeyboardEvent) => {
      // 글자(key)가 아니라 자리(code)로 본다. 맥의 Option+Q 는 key 가 `œ` 이고,
      // 한글 입력 중이면 key 가 `Process` 로 온다.
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== "KeyQ") return;
      e.preventDefault();
      e.stopPropagation();
      void leaveTo(resolved[pair]);
    };
    // 잡는 단계에서 듣는다. 입력칸이 키를 먼저 삼켜도 단축키는 먹어야 한다.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pair, resolved]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    // 열리면 첫 칸에 초점을 둔다. 화살표로 바로 고를 수 있게.
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
    items?.[0]?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onMenuKey = useCallback((e: ReactKeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }, []);

  const self = APPS[SELF];
  const SelfIcon = self.icon;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex items-center gap-2 rounded-full bg-(--color-surface) px-4 py-2 text-sm text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-2)"
        title="다른 앱으로 이동"
      >
        <SelfIcon className="h-4 w-4" />
        <span className="hidden sm:inline">{self.label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-(--color-fg-4) transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-xl bg-(--color-surface) p-1 shadow-lg ring-1 ring-(--color-border-soft)"
        >
          {(Object.keys(APPS) as AppKey[]).map((key) => {
            const meta = APPS[key];
            const Icon = meta.icon;
            const current = key === SELF;
            const shortcut = pair === key ? "Alt+Q" : null;
            const body = (
              <>
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{meta.label}</span>
                  <span className="truncate text-[11px] text-(--color-fg-4)">{meta.hint}</span>
                </span>
                {shortcut && (
                  <kbd className="rounded bg-(--color-bg) px-1.5 py-0.5 font-mono text-[10px] text-(--color-fg-4) ring-1 ring-(--color-border-soft)">
                    {shortcut}
                  </kbd>
                )}
                {current && <Check className="h-4 w-4 shrink-0 text-(--color-accent)" />}
              </>
            );
            if (current) {
              return (
                <div
                  key={key}
                  aria-current="page"
                  className="flex items-center gap-2.5 rounded-lg bg-(--color-surface-2) px-3 py-2 text-sm text-(--color-fg)"
                >
                  {body}
                </div>
              );
            }
            return (
              <a
                key={key}
                role="menuitem"
                href={resolved?.[key] ?? "#"}
                onClick={(e) => {
                  // 메뉴로 갈 때도 저장이 끝나기를 기다린다 — 단축키와 같은 길.
                  // 새 탭으로 여는 누름(Ctrl·가운데 단추)은 이 페이지가 안 떠나니 그대로 둔다.
                  if (!resolved || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
                  e.preventDefault();
                  setOpen(false);
                  void leaveTo(resolved[key]);
                }}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-(--color-fg-2) outline-none transition hover:bg-(--color-surface-2) focus-visible:bg-(--color-surface-2)"
                title={resolved?.[key]}
              >
                {body}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
