import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import {
  MAX_SESSION_NAME,
  countRecordings,
  deleteSession,
  getSessionRow,
  renameSession,
  toSessionDTO,
} from "@/lib/session-server";

/** 세션 하나 — 이름 고치기와 지우기. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getSessionRow(id);
  if (!row) return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ session: toSessionDTO(row) });
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(MAX_SESSION_NAME),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getSessionRow(id)) {
    return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `세션 이름이 필요합니다 (최대 ${MAX_SESSION_NAME}자)` },
      { status: 400 },
    );
  }

  const row = renameSession(id, parsed.data.name);
  if (!row) return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });
  logAgent(req, "세션 이름 바꾸기", row.name);
  return NextResponse.json({ session: toSessionDTO(row) });
}

/**
 * 세션을 지운다. **붙어 있던 녹음의 전사문은 남는다.**
 *
 * 사라지는 것은 이 세션이 들고 있던 것 — 이름과 에이전트 맥락(그동안 오간
 * 대화)이다. 녹음은 `session_id` 가 null 이 되어 "세션 없음" 으로 가고,
 * 그때부터는 예전처럼 **녹음 하나가 곧 세션**으로 돈다. 다듬기도 대화도
 * 그대로 된다.
 *
 * 그렇게 정한 이유: 세션을 지우는 것은 **맥락을 버리는 뜻**이지 전사문을
 * 버리는 뜻이 아니다. cascade 로 두면 이름 하나를 지우려다 몇 시간짜리
 * 전사문이 통째로 사라진다 — 되돌릴 수 없는 쪽이다
 * (`drizzle/0001_sessions.sql` 에 근거가 있다).
 *
 * 응답에 남은 녹음 수를 싣는다. 화면이 "전사문 N건은 그대로 있습니다" 를
 * 말할 수 있어야 사람이 이 단추를 누를 수 있다.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getSessionRow(id);
  if (!row) return NextResponse.json({ error: "세션을 찾을 수 없습니다" }, { status: 404 });

  const kept = countRecordings(id);
  const { deleted } = deleteSession(id);
  logAgent(req, "세션 지우기", row.name, { recordingsKept: kept });

  return NextResponse.json({
    deleted,
    recordingsKept: kept,
    note: kept
      ? `세션을 지웠습니다. 붙어 있던 녹음 ${kept}건의 전사문은 그대로 있습니다 (세션 없음으로 갑니다).`
      : "세션을 지웠습니다.",
  });
}
