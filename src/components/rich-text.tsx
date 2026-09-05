"use client";

import { Fragment, useMemo, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 에이전트 답변용 서식 렌더러.
 *
 * 마크다운 전부가 아니라 에이전트가 실제로 쓰는 것만 그린다 — 제목, 굵게,
 * 기울임, 취소선, 코드, 목록, 인용, 구분선, 링크.
 *
 * 파서를 들이지 않은 이유가 있다. 이 텍스트에는 **메일 본문이 섞여 들어올 수
 * 있다.** 마크다운을 HTML 문자열로 만든 뒤 씻어내는 방식은 씻는 규칙이 한
 * 군데만 새도 그대로 뚫린다. 여기서는 HTML 문자열을 아예 만들지 않고 React
 * 요소만 만든다 — `dangerouslySetInnerHTML` 이 없으므로 태그가 끼어들 자리가
 * 구조적으로 없다.
 *
 * 링크는 지우지 않되 **진짜 호스트를 옆에 드러낸다.** 메일이 심는 링크는 대개
 * 보이는 글자와 실제 주소가 다르다. 주소를 보여 주면 그 수법이 죽는다.
 * 이미지는 불러오지 않는다 — 여는 것만으로 추적 픽셀이 된다.
 */

/** `[[memo:<id>]]` 를 무엇으로 바꿔 그릴지. block=true 면 한 줄을 통째로 차지한다. */
export type MemoSlot = (memoId: string, block: boolean) => ReactNode;

export function RichText({
  text,
  memoSlot,
  className,
}: {
  text: string;
  memoSlot?: MemoSlot;
  className?: string;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("space-y-2", className)}>
      {blocks.map((b, i) => renderBlock(b, i, memoSlot))}
    </div>
  );
}

// ── 블록 나누기 ────────────────────────────────────────────────

interface ListItem {
  text: string;
  /** 들여쓰기 단계 (0~2). 진짜 중첩 대신 여백으로만 표현한다. */
  depth: number;
}

type Block =
  | { k: "p"; text: string }
  | { k: "h"; level: number; text: string }
  | { k: "code"; body: string }
  | { k: "list"; ordered: boolean; items: ListItem[] }
  | { k: "quote"; text: string }
  | { k: "memo"; id: string }
  | { k: "hr" };

const MEMO_ID = "[A-Za-z0-9_-]{1,64}";
/**
 * 한 줄이 통째로 메모 참조인 경우.
 *
 * 블록 단계에서 잘라 내야 한다. 문단으로 합쳐 버리면 참조를 줄마다 하나씩
 * 적었을 때 — 에이전트에게 그렇게 적으라고 시켜 둔 방식이다 — 둘이 한 문단에
 * 갇혀 카드로 그려지지 않는다.
 */
const SOLE_MEMO = new RegExp(`^\\s*\\[\\[memo:(${MEMO_ID})\\]\\]\\s*$`);

const FENCE = /^\s{0,3}```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
/** `---`, `***`, `- - -`. 목록보다 먼저 봐야 한다 — `- - -` 는 양쪽에 걸린다. */
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
/** 표시 뒤 공백을 요구한다. 그래야 `*굵게*` 가 목록으로 잡히지 않는다. */
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function startsBlock(line: string): boolean {
  return (
    !line.trim() ||
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line) ||
    SOLE_MEMO.test(line)
  );
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 닫는 줄. 없으면 끝까지 먹은 것이고 그대로 둔다.
      out.push({ k: "code", body: body.join("\n") });
      continue;
    }

    if (RULE.test(line)) {
      out.push({ k: "hr" });
      i += 1;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({ k: "h", level: h[1].length, text: h[2] });
      i += 1;
      continue;
    }

    const solo = SOLE_MEMO.exec(line);
    if (solo) {
      out.push({ k: "memo", id: solo[1] });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        buf.push(m[1]);
        i += 1;
      }
      out.push({ k: "quote", text: buf.join("\n") });
      continue;
    }

    const ordered = NUMBER.test(line);
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? NUMBER : BULLET;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m) {
          items.push({
            text: m[2],
            depth: Math.min(2, Math.floor(m[1].length / 2)),
          });
          i += 1;
          continue;
        }
        // 들여쓴 이어지는 줄은 바로 앞 항목의 다음 줄로 붙인다.
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !startsBlock(lines[i])) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push({ k: "list", ordered, items });
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && !startsBlock(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ k: "p", text: buf.join("\n") });
  }

  return out;
}

// ── 줄 안쪽 ────────────────────────────────────────────────────

/**
 * 순서가 곧 우선순위다. 코드가 맨 앞이라 백틱 안의 별표는 굵게가 되지 않고,
 * 굵게가 기울임보다 앞이라 `**x**` 가 `*` 두 개로 쪼개지지 않는다.
 *
 * `_기울임_` 은 일부러 뺐다. `some_var_name` 같은 식별자가 기울어진다.
 */
/**
 * 주소 안에 괄호 한 겹까지 받는다.
 *
 * 첫 `)` 에서 끊으면 위키백과처럼 괄호가 든 주소가 중간에 잘리고, 남은 `)`
 * 가 글자로 흘러나온다. `javascript:alert(1)` 도 마찬가지로 반만 잡혀
 * 스킴 검사가 헛돈다 — 잘린 쪽이 우연히 걸러지는 것에 기대면 안 된다.
 */
const URL_BODY = "(?:[^()\\s]|\\([^()\\s]*\\))";

const INLINE = new RegExp(
  [
    "(?<code>`[^`\\n]+`)",
    `(?<memo>\\[\\[memo:${MEMO_ID}\\]\\])`,
    `(?<img>!\\[[^\\]\\n]*\\]\\(${URL_BODY}*\\))`,
    `(?<link>\\[[^\\]\\n]*\\]\\(${URL_BODY}+\\))`,
    "(?<bold>\\*\\*(?:[^*\\n]|\\*(?!\\*))+\\*\\*)",
    "(?<strike>~~[^~\\n]+~~)",
    "(?<em>\\*[^*\\n]+\\*)",
    "(?<auto>https?://(?:[^\\s<>()\\[\\]]|\\([^\\s()]*\\))+)",
  ].join("|"),
  "g",
);

function renderInline(text: string, slot: MemoSlot | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;

  // matchAll 은 정규식을 복제하므로 아래 재귀 호출이 lastIndex 를 건드리지 않는다.
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const g = m.groups ?? {};
    const key = `${keyBase}i${n}`;
    n += 1;

    if (g.code) {
      out.push(
        <code
          key={key}
          className="rounded bg-(--color-bg) px-1 py-0.5 font-mono text-[0.85em] text-(--color-fg)"
        >
          {g.code.slice(1, -1)}
        </code>,
      );
    } else if (g.memo) {
      const id = g.memo.slice("[[memo:".length, -2);
      out.push(
        <Fragment key={key}>
          {slot ? slot(id, false) : <MissingSlot id={id} />}
        </Fragment>,
      );
    } else if (g.img) {
      // 절대 불러오지 않는다. 대체 글자만 남긴다.
      const alt = /^!\[([^\]]*)\]/.exec(g.img)?.[1]?.trim();
      out.push(
        <span key={key} className="text-(--color-fg-4)">
          🖼 {alt || "이미지"}
        </span>,
      );
    } else if (g.link) {
      // 탐욕 매칭이 마지막 `)` 앞까지 먹는다 — 위 URL_BODY 와 짝이 맞는다.
      const mm = /^\[([^\]]*)\]\((.*)\)$/.exec(g.link);
      out.push(<InlineLink key={key} label={mm?.[1] ?? ""} href={mm?.[2] ?? ""} />);
    } else if (g.bold) {
      out.push(
        <strong key={key} className="font-semibold text-(--color-fg)">
          {renderInline(g.bold.slice(2, -2), slot, key)}
        </strong>,
      );
    } else if (g.strike) {
      out.push(
        <s key={key} className="opacity-60">
          {renderInline(g.strike.slice(2, -2), slot, key)}
        </s>,
      );
    } else if (g.em) {
      out.push(<em key={key}>{renderInline(g.em.slice(1, -1), slot, key)}</em>);
    } else if (g.auto) {
      out.push(<InlineLink key={key} label={g.auto} href={g.auto} />);
    }

    last = at + m[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MissingSlot({ id }: { id: string }) {
  return (
    <span className="rounded bg-(--color-bg) px-1.5 py-0.5 font-mono text-[11px] text-(--color-fg-4)">
      메모 {id}
    </span>
  );
}

/** 링크로 만들어 줄 스킴. 나머지는 글자로만 남는다 — `javascript:` 가 여기서 걸린다. */
const OPEN_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return OPEN_SCHEMES.has(u.protocol) ? u : null;
  } catch {
    // 상대 경로도 여기로 온다. 앱 안으로 들어오는 링크를 만들 이유가 없다.
    return null;
  }
}

function InlineLink({ label, href }: { label: string; href: string }) {
  const u = safeUrl(href);
  if (!u) {
    return <span className="text-(--color-fg-4)">{label || href}</span>;
  }
  // hostname 은 국제화 도메인을 punycode 로 돌려준다. 비슷하게 생긴 글자를
  // 쓴 주소가 여기서 정체를 드러낸다.
  const host = u.protocol === "mailto:" ? u.pathname : u.hostname.replace(/^www\./, "");
  const shown = label.trim() || host;
  const reveal = !shown.toLowerCase().includes(host.toLowerCase());
  return (
    <>
      <a
        href={u.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-(--color-accent-strong) underline decoration-(--color-accent)/40 underline-offset-2 transition hover:decoration-(--color-accent)"
      >
        {shown}
      </a>
      {reveal && (
        <span className="ml-1 text-[11px] text-(--color-fg-4)">({host})</span>
      )}
    </>
  );
}

// ── 블록 그리기 ────────────────────────────────────────────────

function renderBlock(b: Block, i: number, slot?: MemoSlot): ReactNode {
  const key = `b${i}`;

  switch (b.k) {
    case "hr":
      return <hr key={key} className="border-(--color-border-soft)" />;

    case "h":
      return (
        <p
          key={key}
          className={cn(
            "font-semibold text-(--color-fg)",
            b.level <= 1 ? "text-[15px]" : b.level === 2 ? "text-[14px]" : "text-[13px]",
          )}
        >
          {renderInline(b.text, slot, key)}
        </p>
      );

    case "code":
      return (
        <pre
          key={key}
          className="scrollbar-thin overflow-x-auto rounded-lg bg-(--color-bg) px-3 py-2"
        >
          <code className="font-mono text-[12px] leading-relaxed text-(--color-fg-2)">
            {b.body}
          </code>
        </pre>
      );

    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-(--color-border) pl-3 whitespace-pre-wrap text-(--color-fg-3)"
        >
          {renderInline(b.text, slot, key)}
        </blockquote>
      );

    case "list": {
      const items = b.items.map((it, j) => {
        const sole = SOLE_MEMO.exec(it.text);
        // 메모 한 개짜리 항목은 글머리표를 떼고 카드로 그린다. 카드 옆에
        // 점이 붙으면 두 번 세는 것처럼 보인다.
        if (sole && slot) {
          return (
            <li key={j} className="-ml-5 list-none">
              {slot(sole[1], true)}
            </li>
          );
        }
        return (
          <li
            key={j}
            style={it.depth ? { marginLeft: `${it.depth}rem` } : undefined}
            className="whitespace-pre-wrap"
          >
            {renderInline(it.text, slot, `${key}l${j}`)}
          </li>
        );
      });
      const cls = "space-y-1 pl-5 marker:text-(--color-fg-4)";
      return b.ordered ? (
        <ol key={key} className={cn(cls, "list-decimal")}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={cn(cls, "list-disc")}>
          {items}
        </ul>
      );
    }

    case "memo":
      // 그릴 줄 모르는 앱에서는 회색 조각으로 남는다. 조각은 인라인이라
      // 감싸 주지 않으면 여러 개가 한 줄에 붙는다.
      return slot ? (
        <Fragment key={key}>{slot(b.id, true)}</Fragment>
      ) : (
        <p key={key}>
          <MissingSlot id={b.id} />
        </p>
      );

    case "p":
      return (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(b.text, slot, key)}
        </p>
      );
  }
}
