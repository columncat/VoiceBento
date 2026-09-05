import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import { MODEL_NOTICE } from "@/lib/model";
import { createRecording, listRecordings, toRecordingDTO } from "@/lib/recording-server";
import { ensureStarted, enqueue, queueDepth } from "@/lib/transcribe";

/**
 * 녹음 목록과 새로 세우기.
 *
 * 목록에 `model` 을 함께 싣는다. 계약에 없는 칸이지만 `RecordingDTO` 는
 * 손대지 않았다 — 봉투에 얹는 것이다. 이 모델이 **한국어를 못 한다**는 사실은
 * 녹음마다 다른 값이 아니라 앱 전체에 늘 참인 것이라, 목록을 여는 자리에서
 * 한 번 주는 편이 맞다 (`lib/model.ts` 의 설명).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  /*
   * 목록을 여는 것이 회수를 깨우는 자리다.
   *
   * 컨테이너가 다시 뜨면 `transcribing` 인 채로 남은 줄이 있다. 첫 요청이
   * 무엇이든 한 번은 여기를 지나므로, 따로 부팅 훅을 만들지 않고 여기서
   * 깨운다 (`ensureStarted` 는 두 번째부터 아무 일도 안 한다).
   */
  ensureStarted();
  return NextResponse.json({
    recordings: listRecordings(),
    model: MODEL_NOTICE,
    queue: queueDepth(),
  });
}

const createSchema = z.object({
  /** MemoBento 파일 id. 이미 올라가 있는 파일을 가리킨다. */
  fileId: z.string().trim().min(1),
  title: z.string().trim().max(500).optional(),
  /** 표시용 원본 이름. 없으면 제목을 쓴다. */
  sourceName: z.string().trim().max(400).optional(),
});

/**
 * 이미 MemoBento 에 있는 파일로 녹음을 세운다.
 *
 * 올리기(`/api/upload/finish`)는 제 손으로 행까지 세우므로 이 길을 지나지
 * 않는다. 여기는 **밖에서** 부르는 자리다 — 메모함에 이미 놓여 있는 소리를
 * 전사하고 싶을 때, 또는 에이전트가 시킬 때.
 */
export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "fileId 가 필요합니다" }, { status: 400 });
  }
  const { fileId, title, sourceName } = parsed.data;

  const row = createRecording({
    title: title || sourceName || "제목 없음",
    fileId,
    sourceName: sourceName ?? title ?? "",
  });

  logAgent(req, "녹음 세우기", row.title, { fileId });
  enqueue(row.id);

  return NextResponse.json({ recording: toRecordingDTO(row) }, { status: 201 });
}
