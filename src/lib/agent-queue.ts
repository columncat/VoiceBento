/**
 * 세션마다 줄 하나 — **같은 세션의 일은 하나씩 돈다.**
 *
 * ## 왜 필요한가
 *
 * 세션 하나는 저쪽(BentoAgent)에서 claude 세션 하나다. 거기에 `--resume` 이
 * 동시에 둘 붙으면 맥락이 꼬인다. 그런데 겹치는 일은 드물지 않다 —
 * 회의 녹음 셋을 한 세션에 나란히 올리면 **전사가 끝나는 대로 다듬기가
 * 저절로 시작되므로**(`transcribe.ts` 의 `maybeAutoPolish`) 셋이 겹친다.
 * 사람이 "다시 다듬기" 를 연달아 누르는 것과 달리 이건 저절로 일어난다.
 *
 * 저쪽에도 방어가 있다 (`BentoAgent/src/queue.ts` 의 `serializeKey`). 그런데
 * 저쪽 다듬기 줄은 지금 **녹음 번호**로 서 있어서(`voice-polish:${recordingId}`)
 * 같은 세션의 다른 녹음끼리는 안 막힌다. 여기서도 서는 이유가 그것이다.
 * 두 겹으로 막는 것이 아니라, 여기 아니면 아무 데도 안 막힌다.
 *
 * ## 왜 전역 줄이 아니라 열쇠별 줄인가
 *
 * 다른 세션끼리는 저쪽에서도 세션이 달라 겹쳐도 꼬이지 않는다. 전역 줄에
 * 세우면 한 시간짜리 녹음을 다듬는 몇 분 동안 다른 세션이 통째로 멈춘다 —
 * BentoAgent 가 논문 대화에서 같은 판단을 했고, 그 결을 따른다.
 *
 * ## 프로세스가 다시 뜨면
 *
 * 이 줄은 메모리에만 있다. 컨테이너가 다시 뜨면 사라지고, 그때 남아 있던
 * `polishing` 줄은 `transcribe.ts` 의 `recoverStaleJobs()` 가 `done` 으로
 * 접는다 (전사문은 이미 온전하고, 잃은 것은 다듬기 결과뿐이라 사람이 버튼
 * 한 번으로 다시 얻는다). 그래서 여기서 되살릴 것이 없다.
 */

interface Lanes {
  /** 열쇠마다 꼬리 하나. 다음 일은 꼬리에 이어 붙는다. */
  tails: Map<string, Promise<unknown>>;
  /** 열쇠마다 기다리는 수. "앞에 N건" 을 말할 재료. */
  depth: Map<string, number>;
}

/*
 * `globalThis` 에 매단다.
 *
 * 개발 모드의 Next 는 모듈을 다시 읽는다. 모듈 지역 변수에 두면 다시 읽힐
 * 때마다 빈 줄이 새로 생겨서, 이미 도는 것을 모르는 채로 같은 세션에 하나
 * 더 붙인다 — 줄이 있는데 없는 것과 같아진다. 전사 줄이 같은 이유로 같은
 * 자리에 매달려 있다 (`transcribe.ts`).
 */
const g = globalThis as typeof globalThis & { __voicebentoLanes?: Lanes };
const lanes: Lanes = (g.__voicebentoLanes ??= { tails: new Map(), depth: new Map() });

/** 지금 이 열쇠에서 무언가 돌고 있나. 응답에 "줄 섰습니다" 를 적을 근거. */
export function laneBusy(key: string): boolean {
  return lanes.tails.has(key);
}

/** 앞에 몇 건이 있나. 도는 것 하나를 포함한다. */
export function laneDepth(key: string): number {
  return lanes.depth.get(key) ?? 0;
}

/**
 * 이 열쇠의 줄 끝에 붙인다.
 *
 * **열쇠를 잡는 것은 동기적이다.** 이 함수가 돌아온 순간 `laneBusy(key)` 가
 * true 다. 그렇지 않으면 "비었나 보고 → await → 붙인다" 사이로 다른 요청이
 * 끼어들어 둘이 나란히 시작한다.
 *
 * 앞엣것이 실패해도 뒤엣것은 돈다 (`then(fn, fn)`). 앞의 다듬기가 실패한
 * 것과 뒤의 녹음을 다듬는 것은 상관이 없다.
 */
export function inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lanes.tails.get(key) ?? Promise.resolve();
  lanes.depth.set(key, laneDepth(key) + 1);

  const next = prev.then(fn, fn);
  const guard = next.catch(() => undefined);
  lanes.tails.set(key, guard);

  void guard.then(() => {
    lanes.depth.set(key, Math.max(0, laneDepth(key) - 1));
    /*
     * 꼬리는 다 돌면 지운다. 안 지우면 세션을 만든 만큼 Map 이 자란다.
     * 그새 뒤에 붙은 것이 있으면 그쪽이 새 꼬리이므로 건드리지 않는다.
     */
    if (lanes.tails.get(key) === guard) {
      lanes.tails.delete(key);
      lanes.depth.delete(key);
    }
  });

  return next;
}
