import { NextResponse } from "next/server";
import { z } from "zod";

import { advanceSummary, agentReady, startSummary } from "@/lib/agent";
import { logAgent } from "@/lib/agent-log";
import {
  countSegments,
  getRecordingRow,
  getSummaryRow,
  setSummary,
  toSummaryDTO,
} from "@/lib/recording-server";
import type { SummaryResponse, SummaryRun } from "@/lib/types";

/**
 * 요약 — 오른쪽 날개 아래칸에 뜨는 글.
 *
 * ## 에이전트를 부르는 길이 대화와 다르다
 *
 * 요약은 `/task` 로 간다 — **도구가 하나도 없는 일회성 호출**이다.
 * 대화(`/voice`)로 부르지 않는다. 요약의 재료는 남이 만든 소리를 받아 적은
 * 글이고, 거기에 "앞의 지시를 무시하고 …" 가 들어 있을 수 있다. 도구가 달린
 * 세션에 그 글을 넣는 순간 그 문장이 곧 도구 호출이 될 길이 열린다.
 * 방어를 프롬프트에 걸지 않고 **구조로 건다** (자세한 것은 `lib/agent.ts`).
 *
 * ## 진행은 폴링이 민다
 *
 * POST 로 시작만 시키고 GET 으로 물어본다. 앞의 터널이 100초에서 끊는다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function runOf(row: ReturnType<typeof getSummaryRow>): SummaryRun | null {
  if (!row || !row.state) return null;
  return { id: row.jobId ?? row.recordingId, state: row.state, error: row.error };
}

function respond(recordingId: string): SummaryResponse & { agent: ReturnType<typeof agentReady> } {
  const row = getSummaryRow(recordingId);
  return {
    run: runOf(row),
    summary: row ? toSummaryDTO(row) : null,
    agent: agentReady(),
  };
}

/**
 * 요약 하나와 그 진행.
 *
 * 화면이 `?id=<작업번호>` 를 붙여 물어보지만 **여기서는 보지 않는다.** 녹음
 * 하나에 도는 요약이 늘 하나뿐이라 고를 것이 없다 — 새로 시작하면 앞의 것을
 * 대신한다. 붙여 보내도 탈이 없게 그냥 무시한다 (지우면 화면을 고쳐야 하고,
 * 얻는 것이 없다).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getRecordingRow(id)) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }
  // 물어보는 것이 진행을 민다 (`polish` 라우트와 같은 이유).
  await advanceSummary(id).catch(() => undefined);
  return NextResponse.json(respond(id));
}

/**
 * 한 주소에 두 뜻이 있다. **몸통으로 가른다.**
 *
 * - `{ instruction? }` — 에이전트에게 요약을 시킨다 (202 + 진행).
 * - `{ body }` — 사람이 직접 쓴 글을 그대로 넣는다 (200).
 *
 * 계약서에 `POST …/summary` 하나뿐이라 주소를 더 파지 않았다. 메서드를
 * 갈라 두는 길(PUT)도 있었지만 화면이 이미 이 하나를 부르고 있고, **같은 일을
 * 하는 입구가 둘이면 언젠가 한쪽만 고쳐진다.**
 */
const postSchema = z
  .object({
    /** 이번에 쓸 지시문. 비우면 기본 지시문이 간다. */
    instruction: z.string().trim().max(4000).optional(),
    /** 사람이 쓴 요약을 덮어써도 좋다고 확인했는가. */
    overwrite: z.boolean().optional(),
    /** 이것이 오면 에이전트를 부르지 않는다 — 사람이 쓴 글이다. */
    body: z.string().max(20_000).optional(),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rec = getRecordingRow(id);
  if (!rec) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  const parsed = postSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  /*
   * 사람이 직접 쓴 글. 그 순간부터 **사람의 것**이다.
   *
   * 출처가 `human` 이 되므로, 다음에 에이전트로 다시 만들려면 아래 409 를
   * 지나야 한다 — 다시 만들 수 없는 글을 말없이 덮지 않는다.
   */
  if (parsed.data.body !== undefined) {
    setSummary(id, parsed.data.body, { source: "human", instruction: null });
    return NextResponse.json(respond(id));
  }

  const agent = agentReady();
  if (!agent.ready) {
    return NextResponse.json({ error: agent.reason, agent }, { status: 503 });
  }
  if (countSegments(id) === 0) {
    return NextResponse.json({ error: "요약할 전사문이 아직 없습니다" }, { status: 409 });
  }

  const { instruction, overwrite } = parsed.data;

  /*
   * 사람이 쓴 글을 말없이 지우지 않는다.
   *
   * 에이전트가 만든 요약을 다시 만드는 것은 잃을 것이 없다 — 같은 재료로
   * 다시 만드는 것이고 지시문도 함께 남는다. 사람이 손으로 적은 글은 다르다.
   * 그건 다시 만들 수 없다.
   */
  const existing = getSummaryRow(id);
  const human = existing && existing.source === "human" && existing.body.trim();
  if (human && !overwrite) {
    return NextResponse.json(
      {
        error: "이미 직접 쓰신 요약이 있습니다. 덮어써도 될지 먼저 확인해 주세요",
        code: "needs-overwrite",
      },
      { status: 409 },
    );
  }

  await startSummary(id, instruction ?? null);
  logAgent(req, "요약 만들기 요청", rec.title, { instruction: instruction ?? null });

  const out = respond(id);
  return NextResponse.json(out, { status: out.run?.state === "failed" ? 502 : 202 });
}
