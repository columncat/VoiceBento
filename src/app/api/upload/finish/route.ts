import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import { MemoBentoError, cancelUpload, finishUpload } from "@/lib/memobento";
import { createRecording, withSession } from "@/lib/recording-server";
import {
  MAX_SESSION_NAME,
  SessionPickError,
  resolveSessionPick,
  sessionOfRecording,
} from "@/lib/session-server";
import { enqueue } from "@/lib/transcribe";
import { discard, loadSession } from "@/lib/upload-session";

/**
 * 조각이 다 갔으면 저쪽에서 확정하고 **녹음 행을 만든다.**
 *
 * 파일만 확정하고 끝내지 않는다. 그러면 "파일은 올라갔는데 녹음이 없는" 틈이
 * 생기고, 그 사이에 브라우저가 끊기면 사람은 어디에도 안 보이는 파일을
 * 올린 셈이 된다. 여기서 행까지 세우고 곧바로 전사 줄에 넣는다.
 *
 * 응답에 `recording` 과 `fileId` 를 함께 싣는다 — 화면은 둘 중 무엇을 써도 된다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  uploadId: z.string().min(1),
  /** 등록할 때 미리 적었다면. 비면 파일 이름이 제목이 된다. */
  title: z.string().trim().max(500).optional(),

  /**
   * 어느 세션에서 처리할지. **둘 중 하나만.** 둘 다 없으면 세션 없이 둔다.
   *
   * `uploadId` 의 "업로드 세션" 과 이름이 겹치지만 아무 상관이 없는 것이다.
   * 저쪽은 조각을 이어 붙이는 동안만 사는 임시 자리이고, 이쪽은 녹음이
   * 처리될 대화 자루다. 아래에서 변수 이름을 갈라 부르는 이유가 그것이다.
   */
  sessionId: z.string().trim().min(1).optional(),
  newSessionName: z.string().trim().min(1).max(MAX_SESSION_NAME).optional(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const session = await loadSession(parsed.data.uploadId);
  if (!session) {
    return NextResponse.json({ error: "업로드 세션을 찾을 수 없습니다" }, { status: 404 });
  }

  /*
   * 대화 자루를 **파일을 확정하기 전에** 정한다.
   *
   * 고른 세션이 사라졌으면 여기서 400 이 나고, 저쪽 임시 파일은 그대로 남아
   * 사람이 다시 시도할 수 있다. 반대로 했다면 파일은 확정되고 세션만 안
   * 붙어, 사람은 이어 붙였다고 믿는데 실제로는 따로 노는 녹음이 남는다.
   */
  let voiceSessionId: string | null;
  try {
    voiceSessionId = resolveSessionPick({
      sessionId: parsed.data.sessionId,
      newSessionName: parsed.data.newSessionName,
    });
  } catch (e) {
    if (e instanceof SessionPickError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  // 브라우저가 경로째 보내는 경우가 있다 (폴더 드래그). 마지막 조각만 이름으로 쓴다.
  const name = (session.name || "untitled").split(/[\\/]/).pop() || "untitled";

  let fileId: string;
  try {
    fileId = await finishUpload(session.remoteId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message },
      { status: e instanceof MemoBentoError ? 502 : 500 },
    );
  }
  await discard(session.id);

  // 확장자를 뗀 것이 제목이다. "2026-03-02 회의.mp4" → "2026-03-02 회의".
  const title = parsed.data.title || name.replace(/\.[^.]+$/, "") || "제목 없음";

  const row = createRecording({
    title,
    fileId,
    sourceName: name,
    sourceSize: session.size,
    sessionId: voiceSessionId,
  });

  logAgent(req, "녹음 올리기", title, {
    file: name,
    size: session.size,
    fileId,
    sessionId: voiceSessionId,
  });

  /*
   * 줄에 넣고 **기다리지 않는다.**
   *
   * 60분짜리가 5분 46초 걸린다(실측 RTF 0.096). 여기서 기다리면 앞의 터널이
   * 100초에서 끊고, 사람은 올리기가 실패한 줄 안다.
   */
  enqueue(row.id);

  return NextResponse.json({
    recording: withSession(row, sessionOfRecording(row)?.name ?? null),
    fileId,
  });
}

/** 사용자가 취소한 업로드 정리. 저쪽 임시 파일도 함께 치운다. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const session = await loadSession(id);
    if (session) await cancelUpload(session.remoteId);
    await discard(id);
  }
  return NextResponse.json({ ok: true });
}
