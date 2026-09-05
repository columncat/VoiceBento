import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import {
  MAX_SESSION_NAME,
  createSession,
  listSessions,
  toSessionDTO,
} from "@/lib/session-server";

/**
 * 세션 목록과 새로 만들기.
 *
 * ## 세션이 하는 일
 *
 * 녹음 여럿이 **한 에이전트 세션**을 나눠 쓴다. 다듬기·대화가 같은 자루에서
 * 돌기 때문에, 방금 다듬으며 정한 화자 이름을 대화창이 알고, 지난주 회의에서
 * 쓴 용어를 이번 주 회의가 물려받는다.
 *
 * 그래서 세션 목록은 **올리기 전에** 필요하다. 파일을 고른 자리에서 어디로
 * 보낼지 정해야 첫 다듬기가 제 세션에서 돈다 — 나중에 옮기면 그 첫 다듬기는
 * 이미 엉뚱한 자루에서 끝난 뒤다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ sessions: listSessions() });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_SESSION_NAME),
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `세션 이름이 필요합니다 (최대 ${MAX_SESSION_NAME}자)` },
      { status: 400 },
    );
  }

  const row = createSession(parsed.data.name);
  logAgent(req, "세션 만들기", row.name);

  return NextResponse.json({ session: toSessionDTO(row) }, { status: 201 });
}
