import { NextResponse } from "next/server";

import { logAgent } from "@/lib/agent-log";
import {
  clearSegments,
  getRecordingRow,
  setRecordingState,
  toRecordingDTO,
} from "@/lib/recording-server";
import { enqueue } from "@/lib/transcribe";

/**
 * 다시 전사한다.
 *
 * 앞의 전사문을 **먼저 지운다.** 남겨 두고 덮어쓰면 새 전사가 앞의 것보다
 * 조각이 적을 때(모델이 다르게 잘랐을 때) 뒤쪽에 옛 줄이 남아 두 전사가
 * 섞인 글이 된다. 그건 어느 쪽도 아닌 글이라 읽는 사람이 알아챌 수 없다.
 *
 * **사람이 고친 줄도 함께 사라진다.** 그래서 화면이 먼저 물어야 한다 —
 * 여기까지 온 요청은 이미 마음먹은 것으로 본다.
 *
 * 202 만 돌려준다. 60분짜리가 5분 46초 걸린다 (실측 RTF 0.096).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }
  if (!row.fileId) {
    return NextResponse.json(
      { error: "이 녹음에는 소리 파일이 없습니다" },
      { status: 409 },
    );
  }
  if (row.state === "extracting" || row.state === "transcribing" || row.state === "queued") {
    return NextResponse.json(
      { error: "이미 전사하고 있습니다", recording: toRecordingDTO(row) },
      { status: 409 },
    );
  }

  clearSegments(id);
  /*
   * 시도 횟수를 0 으로 되돌린다.
   *
   * `attempts` 는 "컨테이너가 다시 뜨는 고리" 를 끊으려고 세는 값이다
   * (`lib/transcribe.ts` 의 `recoverStaleJobs`). 사람이 직접 다시 누른 것은
   * 그 고리가 아니라 새 뜻이므로 여기서 초기화한다 — 안 그러면 두 번 실패한
   * 녹음은 사람이 눌러도 곧바로 접힌다.
   */
  setRecordingState(id, {
    state: "queued",
    progress: null,
    error: null,
    notice: null,
    attempts: 0,
    polishError: null,
    polishJobId: null,
    polishStartedAt: null,
  });
  enqueue(id);

  logAgent(req, "다시 전사", row.title);
  return NextResponse.json({ recording: toRecordingDTO(getRecordingRow(id)!) }, { status: 202 });
}
