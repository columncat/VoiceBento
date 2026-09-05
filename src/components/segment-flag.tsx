"use client";

import { CircleHelp, Languages, Scissors, Sparkle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { SegmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * **에이전트가 "이 줄은 손대지 않았다" 고 표시한 것을 보여 주는 자리.**
 *
 * ## 왜 표시가 필요한가
 *
 * 이 전사 모델은 못 알아듣는 소리에 **빈 글이 아니라 그럴듯한 영어를
 * 지어낸다** (실측: 한국어 오디오에 "Here's snucker, your foo's nick…").
 * 그 사실을 모르는 에이전트는 그 헛소리를 매끄러운 문장으로 "다듬어" 버리고,
 * 그러면 지어낸 글이 사람이 읽기 좋은 모양으로 전사문에 남는다 — 원본이
 * 무엇이었는지 아무 데도 안 적힌 채로.
 *
 * 그래서 에이전트에게 모델의 서술을 넘기고(`modelBrief()` → 저쪽 앞머리), **다듬는
 * 대신 표시하라고** 시킨다. 그 표시가 여기 나온다. 표시가 화면에 안 나오면
 * 시킨 보람이 없다.
 *
 * ## 갈래는 서버가 정한다
 *
 * 값은 `asr-models.ts` 의 `SEGMENT_FLAGS` 네 개이고, 모르는 값은 서버가
 * 버린다(fail closed). 여기서는 그 네 개에 **화면에 적을 말**을 붙이기만
 * 한다. 갈래 이름은 `SegmentDTO["flag"]` 에서 직접 끌어온다 — 따로 적어
 * 두면 서버가 갈래를 늘린 날 화면만 모르는 채로 지나간다.
 *
 * ## 색으로만 나누지 않는다
 *
 * 아이콘 모양이 갈래마다 다르고, 글자로도 무엇인지 적는다. 색은 세 번째
 * 단서다 — 흑백 화면과 색각 이상에서도 "표시된 줄" 임이 읽혀야 한다.
 */

type FlagKind = NonNullable<SegmentDTO["flag"]>;

interface FlagLook {
  label: string;
  hint: string;
  Icon: LucideIcon;
}

const LOOK: Record<FlagKind, FlagLook> = {
  "other-language": {
    label: "모르는 언어",
    hint:
      "이 모델이 알아듣는 언어 목록에 없는 말로 들립니다. 옮겨진 글자는 실제로 한 말과 " +
      "다를 수 있어 다듬지 않고 그대로 두었습니다.",
    Icon: Languages,
  },
  hallucinated: {
    label: "기계가 지어낸 글일 수 있음",
    hint:
      "앞뒤와 이어지지 않아, 못 알아들은 자리에서 기계가 지어낸 글로 보입니다. " +
      "사람이 한 말이 아닐 수 있으니 소리를 직접 들어 보고 판단하세요.",
    Icon: Sparkle,
  },
  unclear: {
    label: "알아볼 수 없음",
    hint:
      "무슨 말인지 알아볼 수 없어 지어내지 않고 날 것 그대로 두었습니다. 소리를 들어 보고 " +
      "고쳐 주세요.",
    Icon: CircleHelp,
  },
  "cut-off": {
    label: "끝에서 잘림",
    hint: "조각 끝에서 말이 잘렸습니다. 시각은 맞고, 문장은 다음 줄로 이어집니다.",
    Icon: Scissors,
  },
};

/**
 * 모르는 갈래에 씌우는 옷.
 *
 * 서버가 fail closed 로 걸러도 화면은 아니다 — 서버가 갈래를 하나 늘렸는데
 * 화면이 그것을 조용히 삼키면, 표시된 줄이 표시되지 않은 줄과 똑같아 보인다.
 * 무엇인지 모르겠으면 "무엇인지 모르겠다" 고 적는 편이 안 적는 것보다 낫다.
 */
const GENERIC: FlagLook = {
  label: "표시됨",
  hint: "에이전트가 이 줄을 다듬지 않고 그대로 두었습니다.",
  Icon: CircleHelp,
};

export interface SegmentFlagView {
  kind: string;
  look: FlagLook;
}

/**
 * 서버가 실어 준 값을 화면이 쓰는 모양으로.
 *
 * `unknown` 으로 받아 손으로 뜯는다 — 이 값은 **에이전트가 지어낸 글을
 * 서버가 거른 뒤** 오는 것이다. 거르는 쪽이 fail closed 라도, 모양이
 * 어긋났을 때 화면이 터지는 것보다 표시가 하나 안 나오는 편이 낫다.
 */
export function normalizeFlag(segment: SegmentDTO): SegmentFlagView | null {
  const raw: unknown = segment.flag;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return { kind: raw, look: LOOK[raw as FlagKind] ?? GENERIC };
}

/** 이 줄에 표시가 붙어 있나. 세는 자리에서 쓴다. */
export function isFlagged(segment: SegmentDTO): boolean {
  return typeof segment.flag === "string" && segment.flag.trim().length > 0;
}

/** 줄 머리에 붙는 알약. `고침` 배지와 같은 자리에 선다. */
export function SegmentFlagBadge({
  flag,
  className,
}: {
  flag: SegmentFlagView;
  className?: string;
}) {
  const { Icon, label, hint } = flag.look;
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-(--color-warn)/12 px-1.5 py-0.5 text-[10px] text-(--color-warn) ring-1 ring-(--color-warn)/30",
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      {label}
    </span>
  );
}

/**
 * 줄 아래에 붙는 한 줄 설명.
 *
 * 알약만으로는 "그래서 내가 무엇을 해야 하나" 가 없다. 짧게 적되 **왜 그
 * 줄이 표시됐는지**와 다음 수(소리를 들어 보라)를 함께 둔다.
 */
export function SegmentFlagNote({ flag }: { flag: SegmentFlagView }) {
  return (
    <p className="mt-1 rounded-md bg-(--color-warn)/8 px-2 py-1 text-[10.5px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-warn)/20">
      {flag.look.hint}
    </p>
  );
}
