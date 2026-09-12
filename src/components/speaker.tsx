"use client";

import { useMemo } from "react";

import { clusterName, placeholderNames } from "@/lib/diarize-assign";
import type { DiarizationDTO, SegmentDTO, SpeakerSource } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 화자를 눈으로 가르는 법.
 *
 * ## 이름이 어디서 왔는지가 이 파일의 절반이다
 *
 * 한 전사문 안에 **근거가 다른 이름 셋**이 섞일 수 있다 (`speakerSource`):
 *
 * - `acoustic` — 소리로 갈랐다. 목소리를 재서 무리를 짓고, 그 무리에 이름을
 *   붙인 것이다. 누가 말했는지는 소리가 정하고 **이름만** 사람/에이전트가 단다.
 * - `agent-guess` — 소리를 **안 들은** 추정이다. 화자 분리가 생기기 전에
 *   올린 녹음에 남아 있다. 에이전트가 대사의 흐름만 보고 지은 이름이다.
 * - `human` — 사람이 그 줄에서 직접 고쳤다.
 *
 * **이 셋을 같은 얼굴로 그리면 안 된다.** 근거가 다른 값을 나란히 놓으면
 * 사람은 둘 다 같은 무게로 믿는다. 그래서 이름은 늘 글자로 보이고
 * (색 점만 있으면 틀린 것을 알아챌 수도, 고칠 수도 없다), 무엇을 근거로
 * 붙은 이름인지는 아래 `SpeakerLegend` 가 한 번 적어 준다.
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

/**
 * 전사문에 나온 순서대로 화자에게 번호를 매긴다.
 *
 * `namer` 가 있으면 **줄 안에서 화자가 바뀌는 자리**(`speakerRuns`)의 이름도
 * 함께 거둔다. 그것이 없으면 한 줄에만 나오는 둘째 화자가 팔레트에서 빠져
 * 색 없이 그려진다 — AMI 조각의 52.2%에 화자가 둘 이상이었으니 드문 일이
 * 아니다.
 */
export function useSpeakerStyles(
  segments: SegmentDTO[],
  namer?: ClusterNamer,
): Map<string, SpeakerStyle> {
  return useMemo(() => {
    const map = new Map<string, SpeakerStyle>();
    const add = (raw: string | null | undefined) => {
      const name = raw?.trim();
      if (!name || map.has(name)) return;
      map.set(name, speakerStyle(map.size, name));
    };
    for (const s of segments) {
      add(s.speaker);
      if (namer) for (const r of s.speakerRuns ?? []) add(namer(r.k));
    }
    return map;
  }, [segments, namer]);
}

// ─────────────────────────────────────────────────────────────
//   군집 번호 → 이름
// ─────────────────────────────────────────────────────────────

/** 군집 번호를 화면에 적을 이름으로. 모르면 null. */
export type ClusterNamer = (k: number | null) => string | null;

/**
 * 줄 안의 토막(`speakerRuns`)에는 **번호만** 있고 이름이 없다.
 *
 * 서버는 조각의 으뜸 군집 하나만 이름으로 풀어 `speaker` 에 담아 준다
 * (`speakerNamer`). 토막마다 이름을 실으면 조각 수천 줄에 같은 글자가
 * 되풀이되므로 그게 맞는 판단인데, 대신 화면이 나머지를 풀 수 있어야 한다.
 *
 * 푸는 규칙은 서버와 **같은 것을 쓴다** — `diarize-assign.ts` 의
 * `placeholderNames`·`clusterName` 을 그대로 부른다. 화면이 제 손으로
 * "화자 N" 을 지으면 서버가 푼 이름과 어긋나는 날이 오고, 그때 같은 목소리가
 * 줄마다 다른 이름으로 앉는다.
 *
 * `otherLabel` 은 서술자에서 온 글자다 (`DiarNoticeDTO.otherLabel`). 화면이
 * 지어내지 않는다.
 */
export function makeClusterNamer(
  diar: DiarizationDTO | null | undefined,
  otherLabel: string,
): ClusterNamer {
  if (!diar) return () => null;
  const order = diar.talkTime.map((t) => t.k);
  const fallback = placeholderNames(order, diar.roster.length, otherLabel);
  const names: Record<number, string> = {};
  for (const [k, v] of Object.entries(diar.names)) {
    const n = Number(k);
    if (Number.isInteger(n) && typeof v === "string" && v.trim()) names[n] = v;
  }
  return (k) => clusterName(k, names, fallback);
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
  source,
  className,
}: {
  styles: Map<string, SpeakerStyle>;
  /**
   * 이 전사문의 이름이 **어디서 왔나.** 줄마다 다를 수 있어 으뜸을 하나 받는다.
   *
   * 한 문장으로 적는 값이 아니다 — 소리로 가른 것과 대사에서 추정한 것은
   * 믿을 근거가 전혀 다르다. 예전에는 여기 "에이전트가 대사에서 추정한
   * 이름입니다" 가 **박혀 있었고**, 소리로 가르기 시작한 날 그 말이 거짓이
   * 되었다. 그래서 값에서 문구가 나오게 한다.
   */
  source: SpeakerSource | null;
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
      {/*
        무엇을 근거로 붙은 이름인지 **여기 한 번** 적는다. 줄마다 적으면
        읽는 데 방해가 되고, 아예 안 적으면 사람이 두 근거를 같은 무게로 믿는다.
      */}
      <span className="text-[10.5px] break-keep text-(--color-fg-4)">
        {source === "acoustic"
          ? "목소리를 재서 가른 이름입니다. 이름 자체는 위 “화자” 에서 목소리마다 고칠 수 있고, 한 줄만 다르면 그 줄에서 고치세요."
          : source === "agent-guess"
            ? "소리를 듣지 않고 대사의 흐름만 보고 지은 이름입니다. 위 “화자” 에서 소리로 다시 나눌 수 있습니다."
            : "사람이 직접 적은 이름입니다."}
      </span>
    </div>
  );
}

/**
 * 이 전사문의 이름이 주로 어디서 왔나. 줄들을 세어 **가장 많은 것**을 고른다.
 *
 * 섞여 있을 수 있다 — 소리로 가른 전사문에서 사람이 몇 줄을 고치면 그 줄만
 * `human` 이다. 그때 "사람이 적은 이름입니다" 라고 적으면 나머지 수백 줄에
 * 대해 거짓말이 된다. 많은 쪽이 그 전사문의 성격이다.
 */
export function dominantSpeakerSource(segments: SegmentDTO[]): SpeakerSource | null {
  const count: Record<string, number> = {};
  for (const s of segments) {
    if (!s.speaker?.trim()) continue;
    // 옛 녹음에는 이 칸이 아예 없다. 그때의 이름은 다듬기가 지은 것이다.
    const src = s.speakerSource ?? "agent-guess";
    count[src] = (count[src] ?? 0) + 1;
  }
  let best: SpeakerSource | null = null;
  let bestN = 0;
  for (const [k, n] of Object.entries(count)) {
    if (n > bestN) {
      bestN = n;
      best = k as SpeakerSource;
    }
  }
  return best;
}
