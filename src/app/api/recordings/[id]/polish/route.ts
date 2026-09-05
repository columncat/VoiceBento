import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AgentUnavailableError,
  TranscriptTooLargeError,
  advancePolish,
  agentReady,
  drivePolishInBackground,
  startPolish,
} from "@/lib/agent";
import { logAgent } from "@/lib/agent-log";
import {
  countSegments,
  getRecordingRow,
  setRecordingState,
  toRecordingDTO,
} from "@/lib/recording-server";

/**
 * 전사문 다듬기 — 에이전트에게 맡긴다.
 *
 * 전사문 **전체를 한 번에** 넘긴다. 조각마다 따로 물으면 앞뒤를 모르는 채로
 * 다듬게 되고, 화자 추정은 아예 못 한다 — 누가 말했는지는 대사의 흐름에서만
 * 나온다 (이 앱은 화자 분리 모델을 쓰지 않는다. 에이전트가 대사에서 추정한다).
 *
 * 붙들지 않는다. 202 와 작업 번호만 주고, 화면이 `GET` 으로 물어본다 —
 * 앞의 Cloudflare 터널이 100초에서 끊는다.
 *
 * ## 넘치면 자르지 않고 말한다
 *
 * 에이전트 입구가 한 번에 받는 본문에 상한이 있다(기본 512KB). 한 시간짜리
 * 회의는 대개 안쪽이지만 넘칠 수 있고, 그때 **조용히 잘라 보내지 않는다.**
 * 자르면 뒤쪽 절반이 다듬어지지 않은 채로 "다듬었습니다" 가 되는데, 사람은
 * 그것을 알아챌 방법이 없다. 413 과 함께 왜 못 보냈는지 말한다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  /**
   * 사람이 적어 주는 한 줄. "무슨 회의인지" 를 알면 화자 추정과 용어 교정이
   * 크게 달라진다. 비워도 된다.
   */
  context: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  const agent = agentReady();
  if (!agent.ready) {
    return NextResponse.json({ error: agent.reason, agent }, { status: 503 });
  }

  if (row.state === "polishing") {
    return NextResponse.json(
      { error: "이미 다듬고 있습니다", jobId: row.polishJobId },
      { status: 409 },
    );
  }
  if (countSegments(id) === 0) {
    return NextResponse.json(
      { error: "다듬을 전사문이 아직 없습니다" },
      { status: 409 },
    );
  }

  const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  const context = parsed.success ? parsed.data.context : undefined;

  let jobId: string;
  try {
    jobId = await startPolish(id, context ?? null);
  } catch (e) {
    if (e instanceof TranscriptTooLargeError) {
      // 자르지 않았다는 말을 그대로 화면에 넘긴다.
      return NextResponse.json(
        { error: e.message, code: "transcript-too-large", bytes: e.bytes, limit: e.limit },
        { status: 413 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message },
      { status: e instanceof AgentUnavailableError ? 502 : 500 },
    );
  }

  setRecordingState(id, {
    state: "polishing",
    polishJobId: jobId,
    polishError: null,
    polishStartedAt: new Date(),
  });
  drivePolishInBackground(id);

  logAgent(req, "전사문 다듬기 요청", row.title, { jobId, hasContext: !!context });

  return NextResponse.json(
    { jobId, recording: toRecordingDTO(getRecordingRow(id)!) },
    { status: 202 },
  );
}

/**
 * 도는 중인 다듬기를 물어본다. **물어보는 것이 진행을 민다.**
 *
 * 서버 타이머만 두면 프로세스가 다시 뜰 때 진행 중이던 것이 영영
 * `polishing` 으로 남는다. 화면이 물어볼 때마다 한 걸음 밀어 두면 그런
 * 일이 없다. 창을 닫고 가는 사람을 위해 타이머도 함께 돈다 — 둘 다 상태를
 * 조건으로 건 UPDATE 라 두 번 반영되지 않는다.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getRecordingRow(id)) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  await advancePolish(id).catch(() => undefined);

  const row = getRecordingRow(id)!;
  return NextResponse.json({
    recording: toRecordingDTO(row),
    jobId: row.polishJobId,
    error: row.polishError,
    agent: agentReady(),
  });
}
