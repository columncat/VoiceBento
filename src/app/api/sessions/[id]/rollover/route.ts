import { NextResponse } from "next/server";

import { logAgent } from "@/lib/agent-log";
import { getSessionRow, rolloverSession, toSessionDTO } from "@/lib/session-server";

/**
 * 이 세션의 **에이전트 맥락만** 새로 시작한다.
 *
 * ## 언제 쓰나
 *
 * 세션에 녹음이 쌓이고 대화가 길어지면 에이전트 맥락이 자란다. 그것은
 * `--resume` 으로 이어 붙으므로 **줄어들지 않는다.** 상한에 닿으면 서버가
 * 다듬기와 대화를 409 로 거절한다 — 잘라 보내면 에이전트가 못 본 대목을
 * "없다" 고 답하기 때문이다.
 *
 * 그때 사람이 고를 수 있는 두 갈래 중 하나가 이것이다.
 *
 * 1. 이 녹음을 새 세션으로 옮긴다 (`PATCH /api/recordings/[id]`).
 * 2. **이 세션의 맥락만 갈아 끼운다 — 여기.** 이름도, 붙어 있는 녹음도,
 *    전사문도, 요약도 그대로다.
 *
 * ## 무엇을 잃나
 *
 * 저쪽에 쌓인 대화 기록이다. 열쇠를 갈면 저쪽에서는 새 세션이 열리므로
 * 지난 대화가 통째로 떨어져 나간다 — 그것이 목적이다. 지난 회차에서 정한
 * 화자 이름도 함께 잊는다.
 *
 * **잃지 않는 것**: 전사문·다듬은 결과·표시·요약은 전부 우리 DB 에 있다.
 * 그리고 대화는 어차피 매 턴 전사문을 다시 실어 보내므로, 다음 한 마디부터
 * 곧바로 제 일을 한다.
 *
 * ## 왜 하위 주소인가
 *
 * "이 칸을 이 값으로 고쳐라" 가 아니라 **"이 물건에 이 동작을 시켜라"** 라서다.
 * 이 앱에 이미 같은 모양이 있다 (`/api/recordings/[id]/retranscribe`).
 * PATCH 의 한 칸으로 두면 이름 고치기와 같은 요청에 실려 실수로 함께 나가는
 * 날이 온다 — 되돌릴 수 없는 동작에 그런 자리를 주지 않는다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const before = getSessionRow(id);
  if (!before) {
    return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });
  }

  const row = rolloverSession(id);
  if (!row) return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });

  logAgent(req, "세션 맥락 새로 시작", row.name, { droppedChars: before.contextChars });

  return NextResponse.json({
    session: toSessionDTO(row),
    note:
      "이 세션의 에이전트 맥락을 새로 시작했습니다. 세션 이름과 붙어 있는 녹음, " +
      "전사문과 요약은 그대로입니다. 그동안 오간 대화는 사라졌습니다.",
  });
}
