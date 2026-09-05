import { NextResponse } from "next/server";
import { z } from "zod";

import { advancePolish } from "@/lib/agent";
import { logAgent } from "@/lib/agent-log";
import { MODEL_NOTICE } from "@/lib/model";
import {
  deleteRecording,
  getRecordingRow,
  listSegments,
  parseNotice,
  renameRecording,
  setRecordingSession,
  withSession,
} from "@/lib/recording-server";
import {
  MAX_SESSION_NAME,
  createSession,
  getSessionRow,
  sessionOfRecording,
  toSessionDTO,
} from "@/lib/session-server";
import { ensureStarted } from "@/lib/transcribe";

/**
 * 녹음 한 건 — 전사문과 세션까지 함께.
 *
 * `model` 도 여기 싣는다. 목록에도 실려 있지만 **전사문 화면은 목록을 안 거치고
 * 바로 열릴 수 있다** (주소를 붙여넣거나 새로고침). 그때 모델 서술자가 없으면
 * 화면이 낱말 클릭을 켤지 접을지 모른다 — `timestamps` 가 `"none"` 인 모델을
 * 붙인 날, 아무 데도 안 뛰는 낱말이 눌리는 채로 남는다.
 */

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

  const session = sessionOfRecording(row);
  return NextResponse.json({
    recording: withSession(row, session?.name ?? null),
    segments: listSegments(id),
    notice: parseNotice(row.notice),
    polishError: row.polishError,
    session: session ? toSessionDTO(session) : null,
    model: MODEL_NOTICE,
  });
}

/**
 * 녹음 한 건의 속성 고치기 — 이름과 **세션.**
 *
 * 세션 옮기기를 여기에 둔 것은 둘 다 "녹음 한 건의 속성" 이라서다. 주소를
 * 하나 더 파지 않았다.
 *
 * `sessionId` 는 **세 가지 뜻**이 있다. 셋을 가르려면 `undefined` 와 `null`
 * 을 구분해서 받아야 한다 — zod 의 `.optional().nullable()` 이 그 자리다.
 *
 * - 안 보냄 (`undefined`) — 세션은 건드리지 않는다.
 * - `null` — 세션에서 뺀다. 그 뒤로는 녹음 하나가 곧 세션이다.
 * - 문자열 — 그 세션으로 옮긴다.
 *
 * **옮겨도 지난 맥락이 따라가지는 않는다.** 저쪽 세션에 이미 쌓인 것은 옛
 * 세션에 남고, 새 세션은 다음 다듬기·대화부터 이 녹음을 안다. 사람이 옮기는
 * 뜻은 "앞으로 여기서 다루자" 이지 "지난 대화를 복사하자" 가 아니다.
 */
const patchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  sessionId: z.string().trim().min(1).nullable().optional(),
  newSessionName: z.string().trim().min(1).max(MAX_SESSION_NAME).optional(),
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
  const { title, sessionId, newSessionName } = parsed.data;

  if (sessionId !== undefined && newSessionName !== undefined) {
    return NextResponse.json(
      {
        error:
          "sessionId 와 newSessionName 을 함께 줄 수 없습니다. 옮길 세션을 고르거나 새로 만드세요.",
      },
      { status: 400 },
    );
  }

  let row = title ? renameRecording(id, title) : getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  if (newSessionName !== undefined) {
    /*
     * 세션을 새로 만들어 옮긴다. 만들기와 붙이기를 한 요청으로 묶은 것은
     * 화면에서 이것이 늘 한 동작이기 때문이다 — 나뉘어 있으면 만들고 붙이기
     * 전에 끊겼을 때 이름만 있는 빈 세션이 남는다.
     */
    row = setRecordingSession(id, createSession(newSessionName).id) ?? row;
  } else if (sessionId !== undefined) {
    if (sessionId !== null && !getSessionRow(sessionId)) {
      return NextResponse.json(
        { error: "옮길 세션을 찾을 수 없습니다 (지워졌을 수 있습니다)" },
        { status: 404 },
      );
    }
    row = setRecordingSession(id, sessionId) ?? row;
  }

  logAgent(req, "녹음 고치기", row.title, {
    ...(title ? { title } : {}),
    ...(sessionId !== undefined || newSessionName !== undefined
      ? { sessionId: row.sessionId }
      : {}),
  });

  const session = sessionOfRecording(row);
  return NextResponse.json({
    recording: withSession(row, session?.name ?? null),
    session: session ? toSessionDTO(session) : null,
  });
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
