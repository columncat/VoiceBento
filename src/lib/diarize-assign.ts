/**
 * 화자 분리 구간을 **낱말에 붙인다.** 순수 함수만 — 의존성이 하나도 없다.
 *
 * 워커(`scripts/diarize.mjs`)가 내놓는 것은 "이때부터 이때까지는 군집 k" 뿐이다.
 * 전사문은 VAD 가 자른 조각 단위라 그 둘의 경계가 안 맞는다. 여기서 그 둘을
 * 겹쳐 놓고 **낱말마다** 누구의 말인지 정한다.
 *
 * ## 왜 이 파일에 sherpa 가 없나
 *
 * 두 가지를 얻는다.
 *
 * 1. **SIGABRT 가 날 수 없다.** 워커가 죽는 두 가지 길(C++ 예외 134 · cgroup
 *    137)은 전부 sherpa 를 부르는 쪽의 일이다. 여기는 배열과 숫자뿐이라
 *    Next 서버 안에서 돌아도 앱을 넘어뜨릴 수 없다.
 * 2. **다시 붙이는 데 7분이 안 든다.** λ 를 바꾸거나 군집→이름 표가 바뀌었을
 *    때, 날 구간(`diarizations.turns`)만 있으면 워커를 다시 안 돌리고 여기만
 *    다시 돌리면 된다. 21분짜리 분리가 332~356초였다 — 그걸 문턱 하나 바꿀
 *    때마다 다시 치를 이유가 없다.
 *
 * ## 무엇을 하는지 — 그리고 그 근거 (AMI 9편 · 낱말 32,091개 실측)
 *
 * | 방식 | 낱말 정확도 | 붙은시간 정확도 |
 * |---|---|---|
 * | 조각 통째 (예전 규칙) | 61.9% | 56.2% |
 * | 화자분리 경계에서 쪼개기 | 72.7% | 64.8% |
 * | **낱말마다 (이 파일)** | **73.5%** | **64.8%** |
 * | 낱말마다 + 갈아타기 값 λ=0.3 | **74.0%** | **65.0%** |
 * | 낱말 시각이 없는 모델 — 글자 수로 나눔 | 68.4% | — |
 *
 * **9편 전부 올랐다.** 이득의 거의 전부는 "쪼갠다" 에서 나온다 — 낱말 단위는
 * 경계 쪼개기보다 +0.8pt 뿐이다. 그래도 낱말 단위를 쓰는 이유는 둘이다:
 * 새로 만드는 오류가 3.0% → 2.4% 로 적고, 토막을 낱말에 되짝짓는 단계가
 * 아예 없어진다(토막이 곧 낱말이다).
 *
 * ## 튐이 무섭게 들리지만, 실제로는 **덜 바꾼다**
 *
 * 조각 안에서 이름표가 바뀌는 횟수: 정답 2,043번 · 이 방식 1,315번.
 * 한 낱말짜리 섬도 정답 190개 · 이 방식 100개다. 진짜 회의에는 "네." 한
 * 마디짜리 차례가 원래 있고, 튐을 다 없애면 그것도 함께 없앤다.
 *
 * 그래서 **다듬는 규칙은 λ 하나뿐이다.** 최빈값 창도(73.5%→73.4~73.5%,
 * 붙은시간은 깎인다) 짧은 덩어리 흡수도(73.4%→73.1%) 전부 손해였다.
 * λ=0.3 만 +0.5pt 이고 한 낱말 덩어리를 231→74 로 줄인다. 여기에 새 규칙을
 * 더하고 싶어지면 먼저 `scratchpad/words/report9.txt` 의 표를 보라.
 */

// ─────────────────────────────────────────────────────────────
//   주고받는 모양
// ─────────────────────────────────────────────────────────────

/** 워커가 낸 구간 하나. `k` 는 군집 번호 — **이름이 아니다.** */
export interface DiarTurn {
  s: number;
  e: number;
  k: number;
}

/** 구간마다의 실루엣. 워커가 0.2초 미만 구간은 건너뛰므로 구간보다 적을 수 있다. */
export interface SilTurn extends DiarTurn {
  sil: number | null;
}

/** `segments.words` 한 칸. `t` 는 **낱말 시작 시각**이고 끝 시각은 없다. */
export interface WordTime {
  w: string;
  t: number;
}

/** 붙일 대상 — 전사 조각 하나. */
export interface AssignSegment {
  idx: number;
  start: number;
  end: number;
  /** 없으면 글자 수 비례로 물러난다 (`timestamps: "none"` 모델). */
  words: WordTime[];
  /** 낱말 시각이 없을 때 나눌 기준. **`raw` 를 준다** — 아래 `charSpans` 설명. */
  raw: string;
}

/** 한 조각 안에서 "여기부터 여기까지는 군집 k" 한 토막. */
export interface SpeakerRun {
  k: number;
  /** 전체 기준 초. 조각의 [start, end] 를 빈틈없이 덮는다. */
  s: number;
  e: number;
  /** 이 토막이 걸친 구간들의 실루엣 (겹친 시간으로 가중). 모르면 null. */
  sil: number | null;
}

/** 어떻게 나눴나. 화면이 "이 줄은 시각이 없어 글자 수로 나눴다" 를 말할 재료. */
export type AssignBasis = "word" | "chars" | "whole";

export interface SegmentSpeaker {
  idx: number;
  /** 이 조각에서 가장 오래 말한 군집. 구간이 하나도 안 닿으면 null. */
  cluster: number | null;
  runs: SpeakerRun[];
  /** 으뜸 군집의 실루엣. 모르면 null. */
  sil: number | null;
  basis: AssignBasis;
}

export interface AssignResult {
  segments: SegmentSpeaker[];
  /**
   * 군집마다 **전사 조각 안에서** 맡은 시간 (초). 많은 순.
   *
   * 워커의 구간 길이가 아니라 실제로 낱말에 붙은 시간이다. 이름을 나눠 줄
   * 때 쓰는 순서가 이것이어야 한다 — 말이 아닌 소리(기침·문 여닫는 소리)가
   * 차지한 구간은 전사 조각 밖이라 여기서 저절로 빠진다.
   */
  talkTime: { k: number; seconds: number }[];
  /** 위 순서의 군집 번호만. 에이전트에게 주는 힌트가 이 순서다. */
  order: number[];
}

// ─────────────────────────────────────────────────────────────
//   구간 다루기 — `scratchpad/words/lib/core.mjs` 를 그대로 옮긴 것
// ─────────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number;
}

/** 겹치는 구간을 하나로 합친다. 합쳐 두어야 겹친 시간을 두 번 세지 않는다. */
function mergeSpans(iv: Span[]): Span[] {
  const sorted = [...iv].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}

/** [a, b] 와 겹친 시간의 합. `iv` 는 합쳐진 것이어야 한다. */
function overlapSum(iv: Span[], a: number, b: number): number {
  let t = 0;
  for (const x of iv) {
    const s = Math.max(x.start, a);
    const e = Math.min(x.end, b);
    if (e > s) t += e - s;
  }
  return t;
}

/**
 * 군집마다의 구간 목록. **첫 등장 순서를 지킨다.**
 *
 * Map 의 열쇠 순서가 아래 비터비에서 동점일 때의 갈림길이 된다. 첫 등장
 * 순서로 두면 `scratchpad/words/evalw.mjs` 와 같은 답이 나온다 — 회귀를
 * 앱 안에서 재현하려면 이 순서가 같아야 한다.
 */
function byCluster(turns: DiarTurn[]): Map<number, Span[]> {
  const m = new Map<number, Span[]>();
  for (const t of turns) {
    if (!Number.isFinite(t.s) || !Number.isFinite(t.e) || t.e <= t.s) continue;
    if (!Number.isInteger(t.k)) continue;
    const list = m.get(t.k);
    if (list) list.push({ start: t.s, end: t.e });
    else m.set(t.k, [{ start: t.s, end: t.e }]);
  }
  for (const [k, v] of m) m.set(k, mergeSpans(v));
  return m;
}

// ─────────────────────────────────────────────────────────────
//   낱말 칸 — 어디서 어디까지가 이 낱말인가
// ─────────────────────────────────────────────────────────────

/**
 * 토큰 시각의 눈금. 그리고 **길이 0 칸을 막을 때 주는 최소 너비.**
 *
 * 이 전사 모델의 시각 해상도가 0.08초다 (실측: 낱말 시작 시각이 그 격자에서
 * 벗어난 낱말 0.0%). 그래서 앞 낱말과 시각이 같은 낱말이 **0.2%** 있다.
 * 그대로 두면 길이 0 짜리 칸이 되어 어느 군집과도 안 겹치고, 겹침으로 고르는
 * 규칙이 통째로 건너뛰어진다 (이웃 구간으로 물러난다). 그 자리를 막는다.
 *
 * 옆 낱말과 살짝 겹치는 것은 해롭지 않다 — 낱말마다 따로 고르므로 칸이
 * 겹쳐도 서로의 답을 밀어내지 않는다.
 */
const MIN_SPAN = 0.08;

interface WordSpan {
  s: number;
  e: number;
}

/**
 * 낱말 칸 = **[이 낱말 시작, 다음 낱말 시작)**. 마지막은 조각 끝까지.
 *
 * 첫 낱말은 조각 시작까지 앞으로 늘린다 — 그래야 세 방식(통째·경계·낱말)이
 * 조각을 똑같이 덮어 붙은시간 정확도를 그대로 견줄 수 있고, 조각 앞머리의
 * 짧은 말이 아무에게도 안 붙는 일이 없어진다.
 *
 * 칸 길이는 중앙값 0.240초이고 **0.08초 이하가 9.0%** 다. 그 짧은 칸의
 * 정확도가 69.4% 로 긴 칸(74.0%)보다 4.6pt 낮다 — 시각 해상도가 한계인
 * 자리이지 이 규칙이 틀린 자리가 아니다.
 */
function wordSpans(seg: AssignSegment): WordSpan[] {
  const ws = seg.words;
  const out: WordSpan[] = [];
  for (let i = 0; i < ws.length; i++) {
    const s = i === 0 ? Math.min(seg.start, ws[0].t) : ws[i].t;
    const raw =
      i === ws.length - 1 ? Math.max(seg.end, ws[i].t) : Math.max(ws[i + 1].t, ws[i].t);
    // 길이 0 을 막는다. 위 MIN_SPAN 설명.
    let e = Math.max(raw, s + MIN_SPAN);
    let start = s;
    if (e <= start) {
      // s 가 이미 조각 끝인 병적인 경우. 뒤가 아니라 앞으로 넓힌다.
      start = Math.max(seg.start, s - MIN_SPAN);
      e = Math.max(s, start + MIN_SPAN);
    }
    out.push({ s: start, e });
  }
  return out;
}

/**
 * 낱말 시각이 없을 때 — **글자 수에 비례해 조각을 나눈다.**
 *
 * `timestamps: "none"` 인 모델(sherpa-onnx 의 whisper 가 그렇다)에서도 막히지
 * 않는다. AMI 에서 이렇게 나누면 **68.4%** 로, 얻는 것의 56%가 남는다 —
 * 조각 통째(61.9%)보다 확실히 낫다.
 *
 * **`raw` 를 나눈다.** `text` 는 다듬기와 사람 손질로 바뀌는데, 그러면 같은
 * 소리에 대한 화자 경계가 글을 고칠 때마다 움직인다. `raw` 는 모델이 들은
 * 그대로라 바뀌지 않는다.
 */
function charSpans(seg: AssignSegment): WordSpan[] {
  const tokens = seg.raw.split(/\s+/).filter((t) => t.length > 0);
  const dur = seg.end - seg.start;
  if (tokens.length === 0 || dur <= 0) return [{ s: seg.start, e: Math.max(seg.end, seg.start + MIN_SPAN) }];

  const weights = tokens.map((t) => Math.max(t.length, 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordSpan[] = [];
  let acc = seg.start;
  for (let i = 0; i < weights.length; i++) {
    const w = (dur * weights[i]) / total;
    const s = acc;
    const e = i === weights.length - 1 ? seg.end : acc + w;
    out.push({ s, e: Math.max(e, s + Math.min(MIN_SPAN, dur)) });
    acc += w;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//   칸 하나에 군집 하나
// ─────────────────────────────────────────────────────────────

/**
 * **겹치는 시간이 가장 긴 군집.** 아무와도 안 겹치면 시간상 가장 가까운 구간의 군집.
 *
 * 물러나는 길이 실제로 쓰이는 일은 드물다 (AMI 32,091 낱말 중 35개, 0.1%).
 * 그래도 있어야 한다 — 분리가 "여기는 아무도 말 안 했다" 고 한 자리에도
 * 전사문에는 낱말이 있고, 그 낱말을 화자 없이 두면 화면에서 그 줄만 이름이
 * 사라진다.
 */
function pickCluster(
  byCl: Map<number, Span[]>,
  flat: DiarTurn[],
  a: number,
  b: number,
): number | null {
  let best: number | null = null;
  let bestOv = 0;
  for (const [k, iv] of byCl) {
    const t = overlapSum(iv, a, b);
    if (t > bestOv) {
      bestOv = t;
      best = k;
    }
  }
  if (best !== null) return best;

  let near: number | null = null;
  let nearDist = Infinity;
  for (const x of flat) {
    const d = x.e < a ? a - x.e : x.s > b ? x.s - b : 0;
    if (d < nearDist) {
      nearDist = d;
      near = x.k;
    }
  }
  return near;
}

/**
 * 갈아타기에 값을 매기는 HMM (비터비). **λ 하나가 유일한 다듬기다.**
 *
 * 방출은 그 칸에서 군집별로 겹친 시간의 비율(라플라스 0.02)이고, 이웃한 칸
 * 사이에서 군집이 바뀌면 `-λ` 를 문다. λ=0.3 에서 낱말 정확도 73.5% → 74.0%,
 * 한 낱말 덩어리 231 → 74 개. λ 를 더 올리면 덩어리는 계속 줄지만 정확도가
 * 도로 내려간다 (λ=1 에 73.8% · λ=2 에 73.7% · λ=8 에 72.5%).
 *
 * **조각 경계에서 끊지 않는다.** 한 녹음의 모든 낱말을 한 줄로 이어 돌린다 —
 * 조각마다 끊으면 조각 첫 낱말이 늘 자유롭게 갈아타서 위 이득이 사라진다.
 */
function viterbi(
  spans: WordSpan[],
  byCl: Map<number, Span[]>,
  labels: number[],
  lambda: number,
): number[] {
  const n = spans.length;
  const L = labels.length;
  if (n === 0 || L === 0) return [];
  if (L === 1) return new Array<number>(n).fill(labels[0]);

  const SMOOTH = 0.02;
  const emission: number[][] = spans.map((sp) => {
    const times = labels.map((k) => overlapSum(byCl.get(k) ?? [], sp.s, sp.e));
    const total = times.reduce((a, b) => a + b, 0);
    return times.map((t) => Math.log((t + SMOOTH) / (total + SMOOTH * L)));
  });

  let prev = emission[0].slice();
  const back: Int32Array[] = [new Int32Array(L).fill(-1)];
  for (let i = 1; i < n; i++) {
    const row = new Array<number>(L);
    const bp = new Int32Array(L);
    for (let k = 0; k < L; k++) {
      let best = -Infinity;
      let arg = 0;
      for (let p = 0; p < L; p++) {
        const v = prev[p] + (p === k ? 0 : -lambda);
        if (v > best) {
          best = v;
          arg = p;
        }
      }
      row[k] = best + emission[i][k];
      bp[k] = arg;
    }
    prev = row;
    back.push(bp);
  }

  let k = 0;
  for (let x = 1; x < L; x++) if (prev[x] > prev[k]) k = x;
  const out = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = labels[k];
    k = back[i][k];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//   실루엣 — **단정하지 않는 쪽으로만 쓴다**
// ─────────────────────────────────────────────────────────────

/**
 * [a, b] 에서 군집 k 의 실루엣. 겹친 시간으로 가중한 평균.
 *
 * 아무 구간과도 안 겹치면 **가장 가까운** 같은 군집 구간의 값을 준다.
 * 그래야 물러난 칸에도 값이 붙는다.
 *
 * 이 값으로 "틀렸다" 고 말하면 안 된다. **낱말 단위로** AUC 0.801 이고, 앱이 쓰는
 * 문턱(−0.2)에서 표시 2.5% · 정밀도 80.4% · 재현율 7.7% 다 (한 편씩 뺀 검증은
 * 79.0% · 6.9%). 표시된 낱말 다섯에 하나는 멀쩡하고, 틀린 낱말의 대부분에는
 * 표시가 없다. 줄 단위로는 잰 적이 없다. **"덜 확실하다" 까지다.**
 */
function silhouetteFor(
  sil: SilTurn[] | undefined,
  k: number | null,
  a: number,
  b: number,
): number | null {
  if (!sil || !sil.length || k === null) return null;
  let weight = 0;
  let acc = 0;
  for (const g of sil) {
    if (g.k !== k || g.sil === null || g.sil === undefined || !Number.isFinite(g.sil)) continue;
    const o = Math.min(g.e, b) - Math.max(g.s, a);
    if (o <= 0) continue;
    acc += g.sil * o;
    weight += o;
  }
  if (weight > 0) return acc / weight;

  let near: number | null = null;
  let nearDist = Infinity;
  for (const g of sil) {
    if (g.k !== k || g.sil === null || g.sil === undefined || !Number.isFinite(g.sil)) continue;
    const d = g.e < a ? a - g.e : g.s > b ? g.s - b : 0;
    if (d < nearDist) {
      nearDist = d;
      near = g.sil;
    }
  }
  return near;
}

/**
 * 이 녹음을 통째로 의심할 것인가 — **분리 구간 실루엣의 중앙값.**
 *
 * 문턱은 서술자가 준다 (`fileWarnSilhouetteMedian`, 지금 0.25). 정확도와
 * Spearman 0.72~0.97 로 붙어 다닌다. 원래 쓰려던 "나온 군집 수 < 요청한 수"
 * 는 AMI 9편에서 **0번** 울렸다 — 안 울리는 경고는 없는 경고다.
 */
export function silhouetteMedian(sil: SilTurn[] | undefined): number | null {
  if (!sil?.length) return null;
  const vals = sil
    .map((g) => g.sil)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

// ─────────────────────────────────────────────────────────────
//   본체
// ─────────────────────────────────────────────────────────────

/** 시각은 소수 셋째 자리까지. 밀리초보다 잘게 저장할 이유가 없다 (DB 가 커질 뿐). */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface AssignInput {
  /** 조각들. `idx` 순이 아니어도 되지만 시간순이면 비터비가 자연스럽다. */
  segments: AssignSegment[];
  turns: DiarTurn[];
  silhouette?: SilTurn[];
  /** HMM 갈아타기 값. 서술자의 `switchPenalty` (0.3). 0 이면 다듬지 않는다. */
  switchPenalty: number;
}

/**
 * 낱말마다 군집을 붙이고, 같은 군집이 잇따르는 곳을 토막으로 묶어 돌려준다.
 *
 * **줄을 새로 만들지 않는다.** 돌려주는 것은 조각 `idx` 마다 토막 목록 하나다
 * — `segments` 의 유일 색인 `(recording_id, idx)` 가 에이전트에게 보내는
 * 번호이고, 행이 늘었다 줄었다 하면 `raw` 의 불변성도 `edited` 보호도 다듬기
 * 계약의 번호도 함께 흔들린다.
 */
interface Labelled {
  ordered: AssignSegment[];
  byCl: Map<number, Span[]>;
  labels: number[];
  spans: WordSpan[];
  /** 조각마다 `spans` 의 어디부터 어디까지인가. */
  bounds: { from: number; to: number; basis: AssignBasis }[];
  /** 칸마다의 군집. `labels` 가 비면 빈 배열이다. */
  picked: number[];
}

/** 1·2단계 — 칸을 만들고 칸마다 군집을 고른다. 아래 둘이 이것을 나눠 쓴다. */
function label(input: AssignInput): Labelled {
  const ordered = [...input.segments].sort((a, b) => a.start - b.start || a.idx - b.idx);
  const byCl = byCluster(input.turns);
  const flat = [...input.turns]
    .filter((t) => Number.isFinite(t.s) && Number.isFinite(t.e) && Number.isInteger(t.k))
    .sort((a, b) => a.s - b.s);
  const labels = [...byCl.keys()];

  // ── 1. 칸을 만든다. 조각 경계를 기억해 두었다가 나중에 도로 나눈다 ──
  const spans: WordSpan[] = [];
  const bounds: { from: number; to: number; basis: AssignBasis }[] = [];
  for (const seg of ordered) {
    const from = spans.length;
    let basis: AssignBasis;
    let mine: WordSpan[];
    if (seg.words.length > 0) {
      mine = wordSpans(seg);
      basis = "word";
    } else if (seg.raw.trim()) {
      mine = charSpans(seg);
      basis = "chars";
    } else {
      // 글도 낱말도 없다. 조각 하나를 통째로 한 칸으로 본다.
      mine = [{ s: seg.start, e: Math.max(seg.end, seg.start + MIN_SPAN) }];
      basis = "whole";
    }
    for (const sp of mine) spans.push(sp);
    bounds.push({ from, to: spans.length, basis });
  }

  // 군집이 하나도 없다 — 분리가 "말한 사람을 못 찾았다" 고 한 경우다.
  // 조용히 아무 이름이나 붙이지 않는다.
  if (labels.length === 0) return { ordered, byCl, labels, spans, bounds, picked: [] };

  // ── 2. 칸마다 군집을 고르고, λ 로 약하게 다듬는다 ──
  const lambda = Number.isFinite(input.switchPenalty) ? Math.max(0, input.switchPenalty) : 0;
  const picked =
    lambda > 0
      ? viterbi(spans, byCl, labels, lambda)
      : spans.map((sp) => pickCluster(byCl, flat, sp.s, sp.e) ?? labels[0]);
  /*
   * 겹침이 0인 칸(AMI 32,091 낱말 중 35개, 0.1%)을 λ 가 있는 길에서 따로
   * 손보지 않는다. 그 칸은 모든 군집의 방출이 같아 **앞 칸을 그대로
   * 따라가는데**, 그것이 곧 "가장 가까운 구간" 과 거의 같은 답이면서
   * 글을 읽을 때는 더 자연스럽다 (한 낱말짜리 섬이 생기지 않는다).
   * 그리고 이렇게 두어야 `scratchpad/words/evalw.mjs` 의 λ=0.3 결과와
   * 같은 값이 나온다 — 회귀를 앱 안에서 재현할 수 있어야 한다.
   */
  return { ordered, byCl, labels, spans, bounds, picked };
}

/**
 * 낱말마다의 군집을 **그대로** 돌려준다. 토막으로 묶기 전의 값이다.
 *
 * `assignSpeakers` 가 저장할 모양으로 묶어 버리기 때문에, 회귀를 재는 쪽은
 * 여기로 들어온다 — `scratchpad/words/` 의 낱말 정확도를 앱 안에서 다시
 * 재려면 낱말과 이름표가 1:1 로 있어야 한다. 재현이 안 되면 옮긴 것이 틀린 것이다.
 */
export function assignWordClusters(input: AssignInput): { idx: number; clusters: number[] }[] {
  const L = label(input);
  return L.ordered.map((seg, si) => ({
    idx: seg.idx,
    clusters: L.picked.slice(L.bounds[si].from, L.bounds[si].to),
  }));
}

export function assignSpeakers(input: AssignInput): AssignResult {
  const { ordered, labels, spans: allSpans, bounds, picked } = label(input);

  if (labels.length === 0) {
    return {
      segments: ordered.map((seg, si) => ({
        idx: seg.idx,
        cluster: null,
        runs: [],
        sil: null,
        basis: bounds[si].basis,
      })),
      talkTime: [],
      order: [],
    };
  }

  // ── 3. 조각마다 토막으로 묶는다 ──
  const talk = new Map<number, number>();
  const out: SegmentSpeaker[] = [];
  for (let si = 0; si < ordered.length; si++) {
    const seg = ordered[si];
    const { from, to, basis } = bounds[si];
    const runs: SpeakerRun[] = [];
    for (let i = from; i < to; i++) {
      const k = picked[i];
      const last = runs[runs.length - 1];
      if (last && last.k === k) last.e = allSpans[i].e;
      else runs.push({ k, s: allSpans[i].s, e: allSpans[i].e, sil: null });
    }
    /*
     * 토막이 조각을 **빈틈없이** 덮게 맞춘다.
     *
     * 낱말 칸은 서로 살짝 겹칠 수 있고(MIN_SPAN 으로 넓힌 자리) 조각 끝을
     * 넘을 수도 있다. 화면은 이 토막으로 글을 나누므로, 겹치거나 빈 자리가
     * 있으면 같은 낱말이 두 화자에 들어가거나 어느 쪽에도 안 들어간다.
     */
    if (runs.length) {
      runs[0].s = seg.start;
      runs[runs.length - 1].e = seg.end;
      for (let i = 1; i < runs.length; i++) {
        if (runs[i].s < runs[i - 1].e) runs[i].s = runs[i - 1].e;
        if (runs[i].e < runs[i].s) runs[i].e = runs[i].s;
      }
    }

    let dominant: number | null = null;
    let dominantTime = 0;
    const perCluster = new Map<number, number>();
    for (const r of runs) {
      const d = Math.max(0, r.e - r.s);
      perCluster.set(r.k, (perCluster.get(r.k) ?? 0) + d);
      talk.set(r.k, (talk.get(r.k) ?? 0) + d);
    }
    for (const [k, d] of perCluster) {
      if (d > dominantTime) {
        dominantTime = d;
        dominant = k;
      }
    }

    for (const r of runs) {
      r.sil = round4(silhouetteFor(input.silhouette, r.k, r.s, r.e));
      r.s = round3(r.s);
      r.e = round3(r.e);
    }

    out.push({
      idx: seg.idx,
      cluster: dominant,
      runs,
      sil: round4(silhouetteFor(input.silhouette, dominant, seg.start, seg.end)),
      basis,
    });
  }

  const talkTime = [...talk.entries()]
    .map(([k, seconds]) => ({ k, seconds: round3(seconds) }))
    .sort((a, b) => b.seconds - a.seconds || a.k - b.k);

  return { segments: out, talkTime, order: talkTime.map((t) => t.k) };
}

function round4(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────
//   군집에 이름 붙이기 — **이름은 에이전트가 정한다**
// ─────────────────────────────────────────────────────────────

/**
 * 아직 이름이 없을 때 화면에 적을 임시 이름.
 *
 * **말한 시간 순서로 로스터 이름을 그냥 끼워 넣지 않는다.** 음향 순서만으로
 * 이름을 맞히면 64.9%(신탁 70.6%)이고 개별 파일에서는 20%까지 무너진다.
 * 틀린 사람 이름이 붙어 있는 것보다 "화자 2" 가 낫다 — 사람 이름은 읽는
 * 사람이 곧바로 사실로 받아들인다.
 *
 * 말한 시간 상위 L개에만 번호를 주고 나머지는 `other` 다. 그 규칙 자체는
 * 신탁과 0.1pt 이내로 붙는다 (실루엣으로 고르면 18.6pt 깎인다 — 하지 마라).
 */
export function placeholderNames(
  order: number[],
  rosterSize: number,
  otherLabel: string,
): Record<number, string> {
  /*
   * 목록이 비어 있으면 **아무도 `other` 로 밀지 않는다.**
   *
   * `other` 는 "사람이 적은 목록에 없던 사람" 이라는 뜻이다. 목록 자체가
   * 없으면 그 말을 할 근거가 없다 — 그때 대부분을 `other` 로 묶으면 실제로
   * 회의를 이끈 사람이 '기타' 가 되어 앉는다.
   */
  const named = rosterSize > 0 ? Math.trunc(rosterSize) : order.length;
  const out: Record<number, string> = {};
  order.forEach((k, i) => {
    out[k] = i < named ? `화자 ${i + 1}` : otherLabel;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
//   다시 나눌 때 이름을 **목소리를 따라** 옮긴다
// ─────────────────────────────────────────────────────────────

/**
 * 새 군집의 시간 중 한 옛 군집에서 온 몫이 이 값 이상이어야 한다 (순도).
 *
 * ## 왜 번호로 옮기면 안 되나
 *
 * sherpa 의 군집 번호는 k 가 바뀌면 뜻이 바뀐다. 사용자 녹음 한 편(21분 26초, 3명)에서
 * 가장 오래 말한 사람이 k=3 에선 1번, k=4·5 에선 2번이다. 번호에 붙은 이름을 그대로 두면
 * 목록을 적고 다시 나눈 뒤 말한 시간의 **45.3%** 만 제 이름이었고, 512초
 * 목소리가 2초짜리 부스러기에 붙었던 이름으로 떴다.
 *
 * ## 문턱의 근거 — 그 녹음의 k=3·4·5 를 서로 짝지어 쟀다
 *
 * (날 구간 기준)
 *
 * - **깨끗한 짝**은 순도가 전부 97.0% 이상이다. k3→k5 의 다섯 군집이
 *   99.8·100·100·100·100%, k5→k4 에서 가장 낮은 것이 97.0%.
 * - **두 목소리가 한 군집으로 합쳐지는 쪽**(k5→k3, k4→k3)은 66.9%·68.9% 다 —
 *   셋째 사람(107초)이 둘째 사람(229초)과 한 군집이 된다. 이때 옛 이름 둘 중
 *   어느 것을 줘도 한 사람은 남의 이름을 단다.
 *
 * 둘 사이가 넓다(68.9 ↔ 97.0). 0.85 는 그 가운데쯤이라 어느 쪽으로도 한참 남는다.
 */
export const NAME_CARRY_PURITY = 0.85;

/**
 * 옛 군집의 시간 중 이 새 군집이 가져간 몫이 이 값을 **넘어야** 한다 (상속).
 *
 * 순도만 보면 **한 목소리가 둘로 갈릴 때** 둘 다 옛 이름을 받는다. k3→k5 에서
 * 옛 0번(342초)이 새 0번(229초, 몫 66.9%)과 새 1번(107초, 31.3%)으로 갈렸고
 * 둘 다 순도가 100% 다. 그런데 새 1번은 k=3 이 둘째 사람에게 붙여 버렸던
 * **셋째 사람**이다 (정답과 맞대 본 기록 — 낱말 197개). 둘 다 옛 이름을 주면 셋째
 * 사람 107초가 둘째 사람 이름으로 뜬다.
 *
 * 과반(0.5 초과)이면 한 옛 이름을 받는 새 군집이 **많아야 하나**라 이름이
 * 둘로 복제될 길이 없다. 반반으로 갈리면 아무도 못 받는다 — 어느 쪽이 그
 * 사람인지 소리로는 말할 수 없으니 그게 맞다. 못 받은 쪽은 임시 이름("화자 N")
 * 으로 뜨고, 사람 이름을 못 옮긴 것은 화면에 "다시 확인해 주세요" 로 남는다.
 */
export const NAME_CARRY_SHARE = 0.5;

/**
 * 옛 군집이 **뚜렷하게 둘로 갈라졌다**고 보는 몫. 옛 군집의 시간 중, 이름을 물려받을
 * 새 군집이 **아닌** 새 군집들로 간 시간(합집합)이 이 값 이상이면, 그 옛 군집에 **사람이**
 * 붙인 이름은 옮기지 않고 "다시 확인" 에 남긴다 (`carryNames`). 몫이 이보다 작아도
 * 초로 뚜렷하면 갈라진 것으로 본다 (`NAME_CARRY_SPLIT_LOW` · `NAME_CARRY_SPLIT_SECONDS`).
 *
 * ## 왜 — 섞였던 목소리의 이름은 다수 목소리의 것이 아닐 수 있다
 *
 * 위 두 문(순도 · 과반)만으로는 **두 목소리가 섞였던 옛 군집**을 못 가린다. 사용자 녹음
 * 한 편을 k=3 으로 나누면 0번이 둘째 사람 229초 + 셋째 사람 107초였다. 사람은 그 줄들
 * 가운데 셋째 사람의 대사를 보고 셋째 사람의 이름을 붙일 수 있다. k=5 로 다시 나누면
 * 0번의 66.9% 가 둘째 사람(새 0번)으로 가고 새 0번의 순도는 100% 라 두 문을 다 지난다 —
 * 그래서 **둘째 사람 목소리 478초에 셋째 사람 이름**이 조용히 떴고, 셋째 사람의 실제
 * 목소리는 "화자 3" 이었다. 섞였던 이름이 두 사람 중 누구를 가리켰는지는 소리가 말해 줄
 * 수 없다. 그러니 옮기지 않는다 — 틀린 사람 이름을 붙이는 것보다 "다시 확인해 주세요" 가
 * 낫다.
 *
 * ## 사람 이름만 — 에이전트 이름은 지금처럼 다수 목소리로 옮긴다
 *
 * 틀렸을 때 **굳느냐**가 다르다. 사람 이름은 `~human` 으로 잠겨, 에이전트가 새 번호로
 * 옳은 표를 보내도 못 고친다(`keptHuman`) — 틀린 목소리로 가면 조용히 굳는다. 에이전트
 * 이름은 안 잠긴다. 다음 다듬기가 새 번호의 대사를 읽고 에이전트 몫을 통째로 갈아
 * 끼운다(`setAgentDiarNames`). 그리고 섞인 군집에 에이전트가 붙인 이름은 대사가 더 많은
 * 쪽, 곧 다수 목소리를 가리키기 쉽다 — 목록 없이 붙인 이름을 k3→k5 로 옮기는 시험
 * (`review/t.cjs` A)에서 다수 목소리로 옮기면 제 이름이 85% 이상이고, 옮기지 않으면
 * 45.4% 로 떨어졌다(다른 목소리에 뜬 이름은 둘 다 0초).
 *
 * ## 겹쳐 말한 시간은 뺀다
 *
 * 분리 구간은 서로 겹칠 수 있다(동시에 말한 자리). 옛 군집이 물려받는 새 군집과 다른 새
 * 군집에 **동시에** 걸친 시간까지 세면 갈라짐이 아니라 겹침을 재게 된다 — k5→k5(같은
 * 판)의 4.8초짜리 부스러기가 28.4% 로 잡혔다(겹친 1.4초). 그래서 물려받는 새 군집과도
 * 겹친 시간을 빼고 잰다.
 *
 * ## 하나가 아니라 **합집합**으로 잰다
 *
 * 예전에는 물려받는 새 군집이 아닌 새 군집 **하나**로 간 가장 큰 몫만 봤다. 그러면 소수
 * 목소리가 새 군집 여럿으로 쪼개질 때 하나하나가 문턱 아래라 못 잡는다 — 390초 군집에
 * 섞였던 90초(23%)가 새 군집 셋에 30초(7.7%)씩 갈리자, 사람이 소수 목소리에 붙인 이름이
 * 다수 목소리 300초에 잠겼다(합성 시험). 그래서 딴 새 군집들로 간 시간을 **모두** 센다.
 * 단순 합이 아니라 합집합인 것은, 딴 새 군집 둘이 서로 겹친 자리(동시에 말한 자리)를 두
 * 번 세면 다시 갈라짐이 아니라 겹침을 재게 되기 때문이다.
 *
 * ## 문턱의 근거 — 사용자 녹음 한 편의 k3·k4·k5 아홉 짝 (합집합 몫, 물려받는 짝 30개)
 *
 * - **뚜렷하게 갈라진 것**: k3→k5 의 0번 32.3%(110초), k3→k4 의 0번 30.6%(105초).
 * - **깨끗한 짝 28개 전부**(k5↔k4 · k4→k5 · k3→k5 의 가장 오래 말한 사람 · 같은 k 끼리):
 *   가장 큰 것이 2.4%(k4→k5 의 0번, 236초 중 5.7초)이고 나머지는 0.7% 이하다. 겹침째 단순
 *   합으로 세도 3.4%(8.0초)라 문턱 아래다.
 *
 * 둘 사이(2.4 ↔ 30.6)가 넓다. 0.15 는 그 가운데쯤이라 어느 쪽으로도 한참 남는다.
 */
export const NAME_CARRY_SPLIT = 0.15;

/**
 * 몫은 `NAME_CARRY_SPLIT` 아래지만 **초로 뚜렷한** 갈라짐을 잡는 둘째 문. 딴 새 군집들로 간
 * 시간이 이 몫 이상이고 **동시에** `NAME_CARRY_SPLIT_SECONDS` 초 이상이면 갈라진 것이다.
 *
 * ## 왜 몫 하나로는 안 되나
 *
 * 긴 옛 군집에 섞였던 소수 목소리는 몫이 작다. 345초 군집에 섞였던 45초(13.0%)는 0.15 에
 * 못 미쳐, 사람이 소수 목소리에 붙인 이름이 다수 목소리 300초에 잠겼다(합성 시험). 그렇다고
 * 몫 문턱을 그냥 낮추면 **짧게 말한 사람**이 다친다 — 20초 말한 사람의 경계가 2초만
 * 흔들려도 10% 라, 깨끗한 이동인데 다시 나눌 때마다 "다시 확인" 으로 떨어진다. 사람이 매번
 * 이름을 다시 붙여야 하면 목소리를 따라 옮기는 기능이 없는 것과 같다.
 *
 * ## 왜 초 바닥 하나로도 안 되나
 *
 * 경계 흔들림은 말한 시간에 따라 는다 — 깨끗한 짝에서 236초 군집이 5.7초 흔들렸다(2.4%).
 * 두 시간짜리 회의의 1,000초 화자라면 같은 비율로 20초를 넘긴다. 몫을 함께 요구하면 그
 * 흔들림은 넘지 못한다. 둘을 **함께** 걸면 짧은 사람은 초에서, 긴 군집은 몫에서 안 걸린다.
 *
 * ## 값
 *
 * 깨끗한 짝의 최대(2.4% · 5.7초)에서 둘 다 세 배 넘게 띄웠다: 8% · 20초. 13%·45초는 걸린다.
 * **못 잡는 것도 있다** — 345초 군집에 섞였던 25초(7.2%)처럼 둘 중 하나라도 못 미치는 소수
 * 목소리는 여전히 다수 목소리로 옮겨진다. 이보다 더 낮추면 깨끗한 짝과의 틈이 좁아진다.
 *
 * 20초 넘게 말한 사람의 경계가 20초 넘게 흔들리는 일(짧은 사람은 몫 15% 문에서 원래 걸릴 수
 * 있다 — 20초짜리의 3초)은 이 문이 새로 만들지 않는다: 20초를 넘으려면 몫 8% 도 넘어야 하고,
 * 깨끗한 짝에서 그런 흔들림은 없었다.
 */
export const NAME_CARRY_SPLIT_LOW = 0.08;

/** `NAME_CARRY_SPLIT_LOW` 와 함께 거는 초 바닥. 근거는 그쪽 설명. */
export const NAME_CARRY_SPLIT_SECONDS = 20;

/** 옛 군집(`total` 초)에서 딴 새 군집들로 간 시간(`away` 초)이 뚜렷한 갈라짐인가. */
export function isSplitAway(away: number, total: number): boolean {
  if (!(total > 0)) return false;
  const share = away / total;
  return (
    share >= NAME_CARRY_SPLIT ||
    (share >= NAME_CARRY_SPLIT_LOW && away >= NAME_CARRY_SPLIT_SECONDS)
  );
}

/** 이름 옮기기 계획 — `carryPlan` 의 결과. */
export interface CarryPlan {
  /** 새 군집 번호 → 이름을 물려받을 옛 군집 번호 (순도·과반을 지난 뚜렷한 짝). */
  heirs: Map<number, number>;
  /**
   * 물려줄 새 군집은 있지만 **두 목소리로 뚜렷하게 갈라진** 옛 군집 번호
   * (`NAME_CARRY_SPLIT`). 여기 든 옛 군집의 **사람** 이름은 옮기지 않는다.
   */
  split: Set<number>;
}

/**
 * 옛 판 구간과 새 판 구간을 **겹친 시간으로** 짝짓는다.
 *
 * @returns 새 군집 번호 → 이름을 물려받을 옛 군집 번호. 뚜렷한 짝만 들어 있다.
 *          같은 옛 번호가 두 번 나오지 않는다 (`NAME_CARRY_SHARE` 가 과반이라서).
 *          갈라짐까지 보려면 `carryPlan` 을 쓴다.
 */
export function carryClusters(oldTurns: DiarTurn[], newTurns: DiarTurn[]): Map<number, number> {
  return carryPlan(oldTurns, newTurns).heirs;
}

/**
 * `carryClusters` 의 짝에 **갈라진 옛 군집**을 함께 얹은 것. 이름 표를 옮기는 쪽
 * (`recording-server.ts` 의 `carryNames`)이 이것을 쓴다 — 짝은 에이전트 이름과 사람
 * 이름이 같이 쓰고, 갈라짐은 사람 이름에만 걸기 때문이다 (`NAME_CARRY_SPLIT` 의 설명).
 */
export function carryPlan(oldTurns: DiarTurn[], newTurns: DiarTurn[]): CarryPlan {
  const oldBy = byCluster(oldTurns);
  const newBy = byCluster(newTurns);
  const oldTotal = new Map([...oldBy].map(([k, iv]) => [k, spanTotal(iv)]));

  const out = new Map<number, number>();
  const split = new Set<number>();
  for (const [nk, niv] of newBy) {
    const nTotal = spanTotal(niv);
    if (!(nTotal > 0)) continue;
    let bestK: number | null = null;
    let bestOv = 0;
    for (const [ok, oiv] of oldBy) {
      let ov = 0;
      for (const x of niv) ov += overlapSum(oiv, x.start, x.end);
      if (ov > bestOv) {
        bestOv = ov;
        bestK = ok;
      }
    }
    if (bestK === null) continue;
    const oTotal = oldTotal.get(bestK) ?? 0;
    if (!(bestOv / nTotal >= NAME_CARRY_PURITY && oTotal > 0 && bestOv / oTotal > NAME_CARRY_SHARE)) {
      continue;
    }
    out.set(nk, bestK);
    if (isSplitAway(splitAway(oldBy.get(bestK) ?? [], nk, newBy), oTotal)) split.add(bestK);
  }
  return { heirs: out, split };
}

function spanTotal(iv: Span[]): number {
  return iv.reduce((a, x) => a + (x.end - x.start), 0);
}

/** 두 구간 목록의 교집합. 둘 다 `mergeSpans` 를 지난 것(정렬 · 겹침 없음)이어야 한다. */
function intersectSpans(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].start, b[j].start);
    const e = Math.min(a[i].end, b[j].end);
    if (e > s) out.push({ start: s, end: e });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/**
 * 옛 군집 구간이 `heir` 가 **아닌** 새 군집들로 간 시간 (초). 딴 새 군집들을 **합집합**으로
 * 묶어 재고, `heir` 와도 겹친 시간(동시에 말한 자리)은 뺀다 — `NAME_CARRY_SPLIT` 의 설명.
 */
function splitAway(oldIv: Span[], heir: number, newBy: Map<number, Span[]>): number {
  const heirIv = newBy.get(heir) ?? [];
  const others: Span[] = [];
  for (const [k, iv] of newBy) if (k !== heir) others.push(...iv);
  const both = intersectSpans(oldIv, mergeSpans(others));
  return spanTotal(both) - spanTotal(intersectSpans(both, heirIv));
}

/** 군집 번호를 화면에 적을 이름으로. 이름 표가 이기고, 없으면 임시 이름. */
export function clusterName(
  k: number | null,
  names: Record<number, string> | null,
  fallback: Record<number, string>,
): string | null {
  if (k === null) return null;
  const given = names?.[k];
  if (typeof given === "string" && given.trim()) return given;
  return fallback[k] ?? null;
}
