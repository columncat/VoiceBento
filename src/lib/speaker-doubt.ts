/**
 * "덜 확실하다" 를 **어느 줄에 붙이나** — 화면과 에이전트가 함께 쓰는 단 하나의 규칙.
 *
 * 의존성이 없다. 화면(`speaker-runs.tsx`·`segment-row.tsx`)과 서버(`agent.ts`)가
 * 둘 다 이 파일을 그대로 부른다.
 *
 * ## 왜 한 곳이어야 하나
 *
 * 예전에는 둘이 다른 신호를 썼다. 화면은 녹음 안 아래 12%·4% 에 0.25 천장을
 * 걸었고, 에이전트는 −0.2 고정 문턱에 `?` 를 붙였다. 사용자 녹음 한 편(k=5, 67줄)에서
 * 화면이 11줄, 에이전트가 2줄을 가리켰다. 사람이 대화창에서 "`?` 붙은 줄" 을
 * 물었을 때 에이전트가 짚는 줄과 화면에 표시된 줄이 다르면, 둘 중 어느 쪽도
 * 믿을 수 없게 된다.
 *
 * ## 왜 −0.2 고정 문턱을 남겼나 — 낱말 단위 실측 (AMI 9편, 낱말 31,839개)
 *
 * | 규칙 | 표시 | 정밀도 | 재현율 |
 * |---|---|---|---|
 * | **낱말 실루엣 ≤ −0.2 (이것)** | 2.5% | **80.4%** | 7.7% |
 * | 한 편씩 빼고 고른 문턱 (편마다 −0.175 ~ −0.319) | 2.3% | 79.0% | 6.9% |
 * | 옛 화면 규칙: 녹음 안 아래 12%, 천장 0.25 | 6.5% | 66.5% | 16.4% |
 * | 옛 화면 규칙: 아래 4% | 3.5% | 73.1% | 9.7% |
 *
 * (`scratchpad/words/silthr.mjs` · `screenrule.mjs`)
 *
 * −0.2 는 한 편씩 뺀 검증이 고른 문턱(중앙값 −0.186)과 같은 자리이고, 같은
 * 정밀도가 나온다. 옛 화면 규칙은 표시를 세 배 가까이 늘리면서 정밀도를 14pt
 * 깎는다 — 표시된 낱말 셋 중 하나가 멀쩡하다. 줄로 옮기면 AMI 1,150줄에서
 * 고정 문턱이 77줄(6.7%), 옛 화면 규칙이 250줄(21.7%)이다. 다섯 줄에 하나 붙는
 * 표시는 배경이 된다.
 *
 * ## 줄로 옮기는 규칙 — **줄 단위로는 잰 적이 없다**
 *
 * 토막(`speakerRuns`)이 있으면 토막마다의 값을, 없으면 줄의 값을 본다. 토막은
 * 한 화자가 잇따라 말한 낱말 묶음이라 낱말에 가장 가깝다. 한 토막이라도 문턱
 * 아래면 그 줄에 붙인다. 위 숫자는 **낱말의 것**이다 — 이 규칙으로 표시한 줄이
 * 얼마나 맞는지는 모른다. 그래서 어느 쪽도 줄에 대해 "몇 %" 를 말하지 않는다.
 *
 * 문턱은 서술자의 `wordSilhouette.flagAt` 에서 온다. 그 칸이 없는 모델(실력을
 * 재 두지 않은 모델)이면 `null` 이 오고, 그때는 **아무 줄에도** 안 붙인다.
 * 실력을 모르는 표시는 그 자체로 거짓 확신이다.
 */

export interface DoubtLine {
  speakerSource?: string | null;
  speakerSil?: number | null;
  speakerRuns?: { sil: number | null }[];
}

/** 실루엣 값 하나가 문턱 아래인가. 값이나 문턱이 없으면 false. */
export function isUnsureSil(sil: number | null | undefined, flagAt: number | null): boolean {
  if (flagAt === null || !Number.isFinite(flagAt)) return false;
  return typeof sil === "number" && Number.isFinite(sil) && sil <= flagAt;
}

/**
 * 이 줄에 "덜 확실하다" 를 붙이나.
 *
 * **소리로 가른 줄에만** 붙인다. 사람이 정한 이름의 근거는 소리가 아니고,
 * 에이전트가 대사로 짐작한 옛 이름(`agent-guess`)에는 실루엣이 없다.
 */
export function isUnsureLine(s: DoubtLine, flagAt: number | null): boolean {
  if (s.speakerSource !== "acoustic") return false;
  const vals = s.speakerRuns && s.speakerRuns.length ? s.speakerRuns.map((r) => r.sil) : [s.speakerSil];
  return vals.some((v) => isUnsureSil(v, flagAt));
}
