"use client";

import { useMemo } from "react";

import type { SegmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 화자를 눈으로 가르는 법.
 *
 * 화자 이름은 에이전트가 **대사에서 추정한 것**이다. 화자 분리 모델을 쓰지
 * 않으므로 틀릴 수 있고, 그래서 이름은 늘 글자로 보여야 한다 — 색 점만 있고
 * 이름이 없으면 틀린 것을 알아챌 수도, 고칠 수도 없다.
 *
 * ## 색만으로 나누지 않는다
 *
 * 한 화자를 가리키는 표시가 넷이다:
 *   1. **이름** — 줄 앞에 글자 그대로.
 *   2. **머리글자 칩** — 이름의 첫 글자. 모양이 다르면 색을 못 봐도 갈린다.
 *   3. **왼쪽 선의 모양** — 실선·파선·점선·이중선이 돌아가며 붙는다.
 *   4. 색.
 *
 * 넷째만 있으면 흑백 인쇄, 색각 이상, 밝기 낮춘 화면에서 전부 같은 회색이
 * 된다. 앞의 셋은 그 어느 경우에도 남는다.
 *
 * ## 번호는 나온 순서대로
 *
 * 이름을 해시해서 색을 고르지 않는다. 해시는 두 화자가 같은 색을 뽑을 수 있고
 * (여덟 색뿐이다) 무엇보다 **이름이 바뀌면 색이 튄다** — 다듬기를 다시 돌려
 * "화자 1" 이 "김 팀장" 이 되는 순간 전사문 전체의 색이 갈아엎어진다. 나온
 * 순서로 매기면 이름이 바뀌어도 자리는 그대로다.
 */

/** 항목 색 팔레트. `globals.css` 의 `:root` 에 있는 것 그대로 — 새로 짓지 않는다. */
const TAG_COLORS = [
  "--color-tag-blue",
  "--color-tag-green",
  "--color-tag-violet",
  "--color-tag-orange",
  "--color-tag-teal",
  "--color-tag-pink",
  "--color-tag-amber",
  "--color-tag-red",
] as const;

/** 왼쪽 선의 모양. 색과 **어긋나게** 돌린다(8 과 4 라 두 바퀴째에 짝이 달라진다). */
const LINE_STYLES = ["solid", "dashed", "dotted", "double"] as const;

export interface SpeakerStyle {
  index: number;
  /** `var(--color-tag-…)` 로 바로 쓸 수 있는 문자열. */
  color: string;
  lineStyle: (typeof LINE_STYLES)[number];
  /** 왼쪽 선 두께. `double` 은 3px 미만이면 한 줄로 뭉개진다. */
  lineWidth: number;
  initial: string;
}

/**
 * 첫 글자 하나.
 *
 * `name[0]` 이 아니라 `Array.from()` 이다. 이모지나 결합 문자가 이름에 들어오면
 * `[0]` 은 반쪽짜리 코드 단위를 잘라 내 깨진 글자를 그린다.
 */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ?? "?";
}

export function speakerStyle(index: number, name: string): SpeakerStyle {
  const lineStyle = LINE_STYLES[index % LINE_STYLES.length];
  return {
    index,
    color: `var(${TAG_COLORS[index % TAG_COLORS.length]})`,
    lineStyle,
    lineWidth: lineStyle === "double" ? 4 : 3,
    initial: initialOf(name),
  };
}

/** 전사문에 나온 순서대로 화자에게 번호를 매긴다. */
export function useSpeakerStyles(segments: SegmentDTO[]): Map<string, SpeakerStyle> {
  return useMemo(() => {
    const map = new Map<string, SpeakerStyle>();
    for (const s of segments) {
      const name = s.speaker?.trim();
      if (!name || map.has(name)) continue;
      map.set(name, speakerStyle(map.size, name));
    }
    return map;
  }, [segments]);
}

/** 줄 앞에 붙는 화자 이름표. */
export function SpeakerTag({
  name,
  style,
  className,
}: {
  name: string;
  style: SpeakerStyle;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 align-middle", className)}
      // 낭독기에는 칩과 이름이 두 번 읽히지 않도록 통째로 하나로 읽힌다.
      aria-label={`화자 ${name}`}
    >
      <span
        aria-hidden
        className="grid h-4.5 w-4.5 shrink-0 place-items-center rounded-[5px] text-[10px] font-semibold"
        style={{
          color: style.color,
          // 표면 위에서 색이 뜨지 않게 아주 옅은 바탕을 깐다. 글자색과 같은
          // 색을 `color-mix` 로 흐리게 만들어 팔레트를 늘리지 않는다.
          background: `color-mix(in oklch, ${style.color} 18%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${style.color} 40%, transparent)`,
        }}
      >
        {style.initial}
      </span>
      <span
        className="text-[12px] font-medium break-keep"
        style={{ color: style.color }}
      >
        {name}
      </span>
    </span>
  );
}

/**
 * 이 전사문에 나온 화자들. 본문 위에 한 줄로 깔아 둔다.
 *
 * 이름이 무엇인지, 어느 선 모양이 누구인지를 한 번에 익히는 자리다. 이게
 * 없으면 사람은 스무 줄쯤 읽고 나서야 파선이 누구였는지 되짚게 된다.
 */
export function SpeakerLegend({
  styles,
  className,
}: {
  styles: Map<string, SpeakerStyle>;
  className?: string;
}) {
  if (styles.size === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      <span className="text-[11px] text-(--color-fg-4)">화자</span>
      {[...styles.entries()].map(([name, s]) => (
        <span key={name} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-3.5 w-0"
            style={{
              borderLeftColor: s.color,
              borderLeftStyle: s.lineStyle,
              borderLeftWidth: s.lineWidth,
            }}
          />
          <SpeakerTag name={name} style={s} />
        </span>
      ))}
      <span className="text-[10.5px] break-keep text-(--color-fg-4)">
        {/* 추정이라는 것을 여기 한 번 적어 둔다. 줄마다 적으면 읽는 데 방해가 된다. */}
        에이전트가 대사에서 추정한 이름입니다. 줄에서 고칠 수 있습니다.
      </span>
    </div>
  );
}
