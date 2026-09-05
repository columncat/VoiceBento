import { NextResponse } from "next/server";
import { z } from "zod";

import { advancePolish } from "@/lib/agent";
import { logAgent } from "@/lib/agent-log";
import {
  deleteRecording,
  getRecordingRow,
  listSegments,
  parseNotice,
  renameRecording,
  toRecordingDTO,
} from "@/lib/recording-server";
import { ensureStarted } from "@/lib/transcribe";

/** 녹음 한 건 — 전사문까지 함께. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureStarted();
  const { id } = await params;

  /*
   * 상세를 여는 것이 다듬기를 미는 자리이기도 하다.
   *
   * 화면은 전사가 도는 동안 이 주소를 몇 초마다 다시 부른다. 그 김에 한 걸음
   * 밀어 두면 폴링 주소를 따로 만들 필요가 없다. 서버 타이머만 두면
   * 프로세스가 다시 뜰 때 진행 중이던 것이 영영 `polishing` 으로 남는다 —
   * 물어보는 요청이 미는 쪽이 훨씬 튼튼하다.
   *
   * 기다리지 않는다. 에이전트가 느리다고 화면이 함께 느려질 이유가 없다.
   */
  const before = getRecordingRow(id);
  if (before?.state === "polishing") void advancePolish(id).catch(() => undefined);

  const row = getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  return NextResponse.json({
    recording: toRecordingDTO(row),
    segments: listSegments(id),
    notice: parseNotice(row.notice),
    polishError: row.polishError,
  });
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!getRecordingRow(id)) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  const row = parsed.data.title ? renameRecording(id, parsed.data.title) : getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }
  logAgent(req, "녹음 이름 바꾸기", row.title);
  return NextResponse.json({ recording: toRecordingDTO(row) });
}

/**
 * 녹음을 지운다. 조각과 요약이 딸려 지워진다.
 *
 * **소리 파일은 안 지운다.** 그것은 MemoBento 의 메모함에 있고, 거기서
 * 지우는 것은 그 메모함을 보는 사람의 일이다. 전사문이 마음에 안 들어 지운
 * 것과 원본을 버리겠다는 것은 다른 뜻이고, 되돌릴 수 없는 쪽으로 기울지
 * 않는 편이 낫다. 응답에 그 말을 실어 화면이 알려 줄 수 있게 한다.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  deleteRecording(id);
  logAgent(req, "녹음 지우기", row.title);

  return NextResponse.json({
    ok: true,
    fileKept: row.fileId !== null,
    note: row.fileId
      ? "전사문을 지웠습니다. 소리 파일은 MemoBento 의 메모함에 그대로 있습니다."
      : null,
  });
}
