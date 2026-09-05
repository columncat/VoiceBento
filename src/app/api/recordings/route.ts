import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import { MODEL_NOTICE } from "@/lib/model";
import { createRecording, listRecordings, withSession } from "@/lib/recording-server";
import {
  MAX_SESSION_NAME,
  SessionPickError,
  listSessions,
  resolveSessionPick,
  sessionOfRecording,
} from "@/lib/session-server";
import { ensureStarted, enqueue, queueDepth } from "@/lib/transcribe";

/**
 * 녹음 목록과 새로 세우기.
 *
 * 목록에 `model` 과 `sessions` 를 함께 싣는다. 계약에 없는 칸이지만
 * `RecordingDTO` 는 손대지 않았다 — 봉투에 얹는 것이다.
 *
 * - `model` — 이 모델이 무엇을 알아듣는가. 녹음마다 다른 값이 아니라 앱
 *   전체에 늘 참인 사실이라 목록을 여는 자리에서 한 번 준다 (`lib/model.ts`).
 * - `sessions` — 올릴 때 고를 자리. **올리기 전에** 있어야 한다. 파일을
 *   고른 자리에서 어디로 보낼지 정해야 첫 다듬기가 제 세션에서 돈다.
 *   나중에 옮기면 그 첫 다듬기는 이미 엉뚱한 자루에서 끝난 뒤다.
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
    sessions: listSessions(),
    queue: queueDepth(),
  });
}

const createSchema = z.object({
  /** MemoBento 파일 id. 이미 올라가 있는 파일을 가리킨다. */
  fileId: z.string().trim().min(1),
  title: z.string().trim().max(500).optional(),
  /** 표시용 원본 이름. 없으면 제목을 쓴다. */
  sourceName: z.string().trim().max(400).optional(),

  /**
   * 어느 세션에서 처리할지. **둘 중 하나만.**
   *
   * 둘 다 없으면 세션 없이 둔다 — 그때는 예전처럼 녹음 하나가 곧 세션이다.
   */
  sessionId: z.string().trim().min(1).optional(),
  newSessionName: z.string().trim().min(1).max(MAX_SESSION_NAME).optional(),
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
  const { fileId, title, sourceName, sessionId, newSessionName } = parsed.data;

  /*
   * 세션을 **녹음을 세우기 전에** 정한다.
   *
   * 고른 세션이 없으면 여기서 400 이 나고 녹음은 안 생긴다. 반대로 했다면
   * 녹음은 생기고 세션만 안 붙어, 사람은 이어 붙였다고 믿는데 실제로는
   * 따로 노는 녹음이 하나 남는다.
   */
  let resolved: string | null;
  try {
    resolved = resolveSessionPick({ sessionId, newSessionName });
  } catch (e) {
    if (e instanceof SessionPickError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const row = createRecording({
    title: title || sourceName || "제목 없음",
    fileId,
    sourceName: sourceName ?? title ?? "",
    sessionId: resolved,
  });

  logAgent(req, "녹음 세우기", row.title, { fileId, sessionId: resolved });
  enqueue(row.id);

  return NextResponse.json(
    { recording: withSession(row, sessionOfRecording(row)?.name ?? null) },
    { status: 201 },
  );
}
