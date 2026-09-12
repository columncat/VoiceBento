"use client";

import { isUnsureSil } from "@/lib/speaker-doubt";
import type { SpeakerRunDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 한 줄 **안에서** 화자가 바뀌는 것을 보이게 하는 자리, 그리고 "덜 확실하다".
 *
 * ## 왜 줄 안을 나눠야 하나 — 이 앱에서 가장 큰 숫자다
 *
 * VAD 가 자른 조각 하나에 화자가 둘 이상인 경우가 **AMI 9편의 52.2%** 다.
 * 줄 통째로 한 사람을 붙이면 낱말 정확도가 61.9% 인데 줄 안을 나누면 73.5% 다.
 * 서버는 이미 그 나눔을 `speakerRuns` 로 실어 보낸다 — **화면이 그것을 안
 * 쓰면 그 차이가 통째로 버려진다.** 사람 눈에는 "한 사람이 다 말한 줄" 로
 * 보이고, 그게 실제로 이 앱이 61.9% 로 되돌아간 모습이다.
 *
 * 사용자 녹음 한 편(21분 26초, 3명)에서도 같았다 — 이름표가 바뀌는 58군데 중
 * **50군데가 조각 하나 안**이었다. 줄 경계에서만 화자를 바꾸면 그 50군데를
 * 그릴 자리가 없다.
 *
 * ## 튐이 무서워 다듬지 않는다
 *
 * 한 낱말만 화자가 튀어 보이는 자리가 눈에 거슬려서 "짧은 덩어리는 이웃에
 * 붙이자" 는 규칙을 넣고 싶어진다. **넣으면 안 된다.** 실측에서 그런 규칙은
 * 거의 다 정확도를 깎았고, 무엇보다 **정답이 우리보다 더 자주 바꾼다**
 * (조각 안에서 정답 2,043번 대 우리 1,315번, 한 낱말 섬도 정답 190개 대
 * 우리 100개). 여기서 다듬으면 화면이 서버와 다른 글을 그리게 되고,
 * 대화·요약이 읽는 것과 사람이 보는 것이 갈라진다.
 */

export interface Word {
  w: string;
  /** 전체 기준 초. */
  t: number;
}

export interface RunChunk {
  /** 군집 번호. 이름은 `ClusterNamer` 가 푼다. */
  k: number;
  /** 이 토막의 실루엣. 모르면 null. */
  sil: number | null;
  /** 재생 손잡이로 쓸 시각. */
  start: number;
  words: Word[];
}

/**
 * 보이는 낱말들을 토막에 나눠 담는다. 토막이 하나뿐이면 **빈 배열**을 돌려준다
 * (부르는 쪽이 예전처럼 통글자로 그리게).
 *
 * 두 길이 있고 저장된 모양은 둘 다 같다 — 그래서 여기서도 한 함수로 받는다.
 *
 * - **낱말 시각이 있을 때**: 낱말의 시작 시각이 어느 토막에 드는지로 나눈다.
 *   서버가 낱말마다 군집을 고른 것과 같은 기준이라 자리가 어긋나지 않는다.
 * - **없을 때** (`timestamps: "none"` 모델): 글자 수를 **토막 길이에 비례해**
 *   나눈다. 서버의 `charSpans` 가 하는 것의 되짚음이다. 이 길로도 낱말
 *   정확도 68.4% 가 남는다 (줄 통째 61.9% 보다 낫다).
 */
export function splitByRuns(
  shown: Word[],
  runs: SpeakerRunDTO[] | undefined,
  hasWordTimes: boolean,
): RunChunk[] {
  if (!runs || runs.length <= 1 || shown.length === 0) return [];

  const buckets: Word[][] = runs.map(() => []);

  if (hasWordTimes) {
    /*
     * 낱말은 시각 순이고 토막도 시각 순이라 한 번만 훑으면 된다. 토막을
     * 못 찾은 낱말(첫 토막보다 앞선 것)은 첫 토막에 둔다 — 서버도 조각
     * 앞머리를 첫 칸까지 늘려 아무에게도 안 붙는 낱말이 없게 한다.
     */
    let ri = 0;
    for (const w of shown) {
      while (ri < runs.length - 1 && w.t >= runs[ri + 1].s) ri++;
      buckets[ri].push(w);
    }
  } else {
    const dur = runs.map((r) => Math.max(0, r.e - r.s));
    const totalDur = dur.reduce((a, b) => a + b, 0) || 1;
    const totalChars = shown.reduce((a, w) => a + w.w.length, 0) || 1;
    let ri = 0;
    let acc = 0;
    let target = (dur[0] / totalDur) * totalChars;
    for (const w of shown) {
      buckets[ri].push(w);
      acc += w.w.length;
      while (ri < runs.length - 1 && acc >= target) {
        ri++;
        target += (dur[ri] / totalDur) * totalChars;
      }
    }
  }

  /*
   * 낱말이 한 개도 안 떨어진 토막은 버린다. 짧은 토막에서 일어난다 —
   * 그 자리에 빈 이름표만 서 있으면 "여기서 누군가 한 마디 했는데 글이
   * 없다" 로 읽히는데, 실제로는 나눌 낱말이 없었을 뿐이다.
   */
  const out: RunChunk[] = [];
  runs.forEach((r, i) => {
    if (buckets[i].length === 0) return;
    /*
     * 빈 토막을 버리고 나면 **같은 군집 둘이 맞붙을 수 있다** (A · 낱말 없는 B · A).
     * 그대로 두면 한 사람이 한 줄 안에서 이름표를 두 번 달고, 머리의 "화자 N명"
     * 은 1명인데 토막은 둘로 그려진다 — 사용자 녹음의 한 줄에서 실제로 봤다.
     * 붙여서 하나로 만든다. 실루엣은 **낮은 쪽**을 남긴다: "덜 확실하다" 를
     * 합치다가 지우는 쪽으로 틀리면 안 된다.
     */
    const last = out[out.length - 1];
    if (last && last.k === r.k) {
      last.words.push(...buckets[i]);
      if (r.sil !== null && (last.sil === null || r.sil < last.sil)) last.sil = r.sil;
      return;
    }
    out.push({ k: r.k, sil: r.sil, start: r.s, words: buckets[i] });
  });
  // 한 토막으로 뭉쳤으면 나눌 것이 없다.
  return out.length > 1 ? out : [];
}

// ─────────────────────────────────────────────────────────────
//   "덜 확실하다" — 단정하지 않는다
// ─────────────────────────────────────────────────────────────

/**
 * 0 = 말할 것 없음 · 1 = 덜 확실하다.
 *
 * ## 문턱은 **에이전트의 `?` 와 같은 값 하나**다
 *
 * 예전에는 여기서 녹음 안의 상대 순위로 눈금을 지었다(아래 12%에 옅게, 4%에
 * 진하게, 천장 0.25). 에이전트는 −0.2 고정 문턱에 `?` 를 붙였다. 둘이 다른
 * 신호라 사용자 녹음 한 편(67줄)에서 화면 11줄 · 에이전트 2줄이 갈렸고, 사람이 대화창에서
 * "`?` 붙은 줄" 을 물으면 에이전트가 짚는 줄이 화면에 표시된 줄과 달랐다.
 *
 * 규칙은 `lib/speaker-doubt.ts` 한 곳에 있다. 왜 −0.2 를 남겼나도 거기 적었다 —
 * 낱말 단위로 재면 옛 화면 규칙은 표시 6.5% · 정밀도 66.5%, −0.2 는 표시 2.5% ·
 * 정밀도 80.4% 다. 단계를 둘로 나누던 것도 접었다: 진한 단계(아래 4%)를 받쳐
 * 줄 실측이 없다.
 *
 * @param unsureAt `DiarNoticeDTO.unsureSilhouette`. 모르면 null — 그때는 아무것도 안 붙인다.
 */
export function doubtLevel(sil: number | null | undefined, unsureAt: number | null): 0 | 1 {
  return isUnsureSil(sil, unsureAt) ? 1 : 0;
}

/**
 * 또렷함 표시 — 작은 막대 셋.
 *
 * 색으로만 가르지 않는다. **채워진 막대 수**가 말을 하고, 색은 거들기만 한다.
 * 흑백 화면과 색각 이상에서도 보인다.
 */
export function DoubtMark({
  level,
  open,
  onToggle,
  className,
}: {
  /** 0 이면 아무것도 안 그린다. 부르는 쪽이 0 을 거르지 않아도 되게. */
  level: 0 | 1;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  if (level === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="이 줄은 목소리가 덜 또렷하게 갈렸습니다. 눌러서 설명 보기"
      title="왜 이 표시가 붙었는지 보기"
      className={cn(
        "inline-flex h-4 items-end gap-[1.5px] rounded-sm px-0.5 align-middle transition",
        open ? "bg-(--color-surface-hi)" : "opacity-60 hover:opacity-100",
        className,
      )}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            "w-[2.5px] rounded-[1px]",
            i === 0 ? "h-1.5" : i === 1 ? "h-2.5" : "h-3.5",
            i < 1 ? "bg-(--color-warn)" : "bg-(--color-border-soft)",
          )}
        />
      ))}
    </button>
  );
}

/**
 * 눌렀을 때 뜨는 설명. **"틀렸다" 고 말하지 않는다.**
 *
 * 숫자를 안 적는다. 정밀도·재현율을 적어 두면 사람은 그 수를 이 줄 하나에
 * 대한 확률로 읽는데, 그건 **낱말 단위로** 잰 수이고 줄 단위로는 잰 적이 없다.
 * 대화창의 에이전트도 이 줄을 `?` 로 받는다는 것은 적는다 — 둘이 같은 줄을
 * 가리킨다는 사실이 사람이 둘을 견줄 때 필요하다.
 */
export function DoubtNote({ level }: { level: 0 | 1 }) {
  if (level === 0) return null;
  return (
    <p className="mt-1 flex items-start gap-1.5 rounded-md bg-(--color-bg-2) px-2.5 py-1.5 text-[11px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)">
      <span aria-hidden className="mt-px shrink-0 text-(--color-fg-4)">
        ⌁
      </span>
      <span className="min-w-0">
        이 줄은 목소리가 덜 또렷하게 갈렸습니다.{" "}
        <b className="font-medium text-(--color-fg-2)">틀렸다는 뜻은 아닙니다</b> — 이 표시는 멀쩡한
        줄에도 붙고, 이름이 잘못 붙은 줄에는 대개 안 붙습니다. 대화창의 에이전트에게도 이 줄은
        이름 뒤에 “?” 가 붙어 갑니다. 여기 붙은 이름을 근거로 삼기 전에 소리를 한 번 들어 보세요.
      </span>
    </p>
  );
}
