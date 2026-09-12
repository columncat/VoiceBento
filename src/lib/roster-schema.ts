import { z } from "zod";

import { dedupeNames, nameKey } from "./name-key";

/**
 * 화자 목록을 받는 **한 가지 모양.** 화자 나누기(`…/diarize`)와 올리기
 * (`/api/upload/finish`, `POST /api/recordings`)가 같은 문을 지난다.
 *
 * 둘이 따로 zod 를 들면 한쪽만 40자·60명 울타리를 고치는 날이 오고, 그러면
 * 올릴 때 받아 둔 목록이 나누기 라우트에서는 거절되는 모양이 된다.
 */

/**
 * 목록 상한. **사람 수를 재는 값이 아니라 터무니없는 입력을 막는 울타리다.**
 *
 * 이 수만큼 적으면 `k` 가 62가 되는데, 그건 이미 "수를 모른다" 와 다를 바
 * 없는 상태다. 실제 회의는 한 자릿수다.
 */
export const MAX_ROSTER = 60;

/** 이름 하나의 길이. 넘으면 이름이 아니라 문장이다 (에이전트 쪽 `MAX_SPEAKER_NAME` 과 같은 값). */
export const MAX_ROSTER_NAME = 40;

/*
 * 문구를 전부 한국어로 단다. **이 문장들이 그대로 화면에 뜬다** — zod 의
 * 기본값은 "Required" · "Array must contain at most 60 element(s)" 라서, 하나라도
 * 빠뜨리면 그 자리만 영어로 뜬다.
 */
const rosterBase = () =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1, "빈 이름은 넣을 수 없습니다.")
        .max(MAX_ROSTER_NAME, "이름이 너무 깁니다.")
        /*
         * 폭 없는 공백(U+200B) 같은 **보이지 않는 글자만으로 된 이름**은 `trim()` 을 지나
         * 한 글자로 남는다. 그대로 받으면 목록에서 한 명으로 세어지다가 같음 열쇠에서는
         * 빈 이름이 되어 사라진다 — 사람은 적었다고 보고, 서버는 인원을 다르게 센다.
         * 같은 열쇠(`nameKey`)로 비면 빈 이름과 같은 문장으로 거절한다.
         */
        .refine((v) => nameKey(v).length > 0, "빈 이름은 넣을 수 없습니다."),
      {
        required_error: "말한 사람을 적어도 한 명은 적어 주세요.",
        invalid_type_error: "말한 사람 목록이 없습니다.",
      },
    )
    .max(MAX_ROSTER, `한 번에 ${MAX_ROSTER}명까지 적을 수 있습니다.`);

/** 화자 나누기 — **한 명 이상 반드시.** 사람 수를 안 주면 화자가 40~134명 나온다. */
export const requiredRoster = () => rosterBase().min(1, "말한 사람을 적어도 한 명은 적어 주세요.");

/**
 * 올리기 — **선택.** 안 적으면 자동 분리를 건너뛴다 (`ROSTER_MISSING`).
 *
 * 올리기를 목록 때문에 막지 않는다. 전사문이 화자보다 먼저다.
 */
export const optionalRoster = () => rosterBase().optional();

/**
 * 같은 이름을 두 번 적은 것은 **한 명으로 센다.** 두 번 세면 `k` 가 하나
 * 커지는데, 그건 사람이 뜻한 바가 아니라 손이 미끄러진 것이다. 순서는 적은
 * 그대로 둔다 — 이름을 나눠 줄 때 쓰는 순서가 아니고(그건 말한 시간 순이다),
 * 화면에 다시 그릴 때 적은 대로 보이는 편이 낫다.
 *
 * "같은 이름" 이 무엇인지는 여기서 정하지 않는다 (`name-key.ts`). 예전에는 여기가
 * "글자가 똑같은가" 였고 닫힌 집합은 "대소문자·조합형 무시" 여서, `["Alpha","alpha"]`
 * 가 여기서는 두 명 · 저기서는 한 명이었다.
 */
export function dedupeRoster(roster: string[]): string[] {
  return dedupeNames(roster);
}
