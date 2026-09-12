import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import {
  editSegment,
  getDiarizationRow,
  getRecordingRow,
  getSegmentRow,
  speakerNamer,
  toSegmentDTO,
} from "@/lib/recording-server";

/**
 * 전사문 한 줄 고치기.
 *
 * 이 라우트를 지나는 순간 그 줄에 `edited` 가 선다. 그 뒤로는 다시 다듬어도
 * 이 줄은 안 덮인다 — 사람이 고쳐 쓴 문장을 기계가 되돌리는 것은 되돌릴 수
 * 없는 손해다. 모델이 잘못 들은 것은 `raw` 에 남아 있지만, 사람이 다시 쓴
 * 문장은 어디에도 없다.
 *
 * `raw` 는 여기서 손댈 수 없다. 일부러 몸통 스키마에 넣지 않았다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z
  .object({
    text: z.string().max(8000).optional(),
    /** null 이면 화자를 지운다. */
    speaker: z.string().trim().max(40).nullable().optional(),
  })
  .refine((v) => v.text !== undefined || v.speaker !== undefined, {
    message: "고칠 것이 없습니다",
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; sid: string }> },
) {
  const { id, sid } = await params;

  if (!getRecordingRow(id)) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }
  if (!getSegmentRow(id, sid)) {
    return NextResponse.json({ error: "그 줄을 찾을 수 없습니다" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  const row = editSegment(id, sid, {
    ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
    ...(parsed.data.speaker !== undefined
      ? { speaker: parsed.data.speaker || null }
      : {}),
  });
  if (!row) {
    return NextResponse.json({ error: "그 줄을 찾을 수 없습니다" }, { status: 404 });
  }

  logAgent(req, "전사문 한 줄 고치기", id, { segment: sid });
  /*
   * 이름 표를 함께 넘긴다. 소리로 가른 줄의 화자는 군집 **번호**로 저장되고
   * 읽을 때 이름으로 풀리는데(`speakerNamer`), 여기서 그것을 빼먹으면 글만
   * 고친 줄이 이 응답에서만 화자 없이 돌아온다. 화면이 그 한 줄을 제자리에
   * 갈아 끼우면 목록에서 그 줄의 이름만 사라진다.
   */
  return NextResponse.json({ segment: toSegmentDTO(row, speakerNamer(getDiarizationRow(id))) });
}
