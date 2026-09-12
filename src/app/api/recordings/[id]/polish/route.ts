import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AgentSessionFullError,
  AgentUnavailableError,
  PolishBusyError,
  PolishContextTooLongError,
  TranscriptTooLargeError,
  advancePolish,
  agentReady,
  queuePolish,
} from "@/lib/agent";
import { logAgent } from "@/lib/agent-log";
import {
  countSegments,
  getRecordingRow,
  toRecordingDTO,
  withSession,
} from "@/lib/recording-server";
import { SessionContextFullError, sessionOfRecording, toSessionDTO } from "@/lib/session-server";

/**
 * 전사문 다듬기 — 에이전트에게 맡긴다.
 *
 * 전사문 **전체를 한 번에** 넘긴다. 조각마다 따로 물으면 앞뒤를 모르는 채로
 * 다듬게 된다.
 *
 * ## 화자는 **줄이 아니라 무리**에 붙는다
 *
 * 누가 언제 말했는지는 소리가 정한다 (`lib/diarize-assign.ts`). 에이전트가
 * 정하는 것은 **군집 → 이름 표 하나**이고, 그러려면 대사 전체를 봐야 한다 —
 * 이름은 "고맙습니다, 지훈 씨" 같은 자리에서만 나오는데 그 자리가 어느
 * 조각인지는 미리 알 수 없다.
 *
 * 응답 모양에는 **줄마다의 화자를 넣을 자리가 아예 없다** (`agent.ts` 의
 * `readItems`). 안내문으로만 막으면 코드로는 열려 있고, 열려 있는 문은
 * 언젠가 쓰인다. 음향이 말한 시간 순서만으로 이름을 맞히면 64.9%(신탁
 * 70.6%)이고 개별 파일에서 20%까지 무너지므로 **이름은 에이전트가 정하는
 * 것이 맞다.** 다만 정하는 단위가 줄이 아니어야 한다.
 *
 * 붙들지 않는다. 202 와 작업 번호만 주고, 화면이 `GET` 으로 물어본다 —
 * 앞의 Cloudflare 터널이 100초에서 끊는다.
 *
 * ## 세션 — 줄을 설 수 있다
 *
 * 같은 세션의 다듬기는 하나씩 돈다 (세션 하나가 저쪽에서 claude 세션 하나라,
 * `--resume` 이 겹치면 맥락이 꼬인다). 그래서 202 에 `jobId` 가 없을 수
 * 있다 — `queued: true` 가 그 뜻이고, 녹음은 이미 `polishing` 이다.
 * 화면은 평소처럼 `state` 만 따라가면 된다.
 *
 * ## 넘치면 자르지 않고 말한다
 *
 * 넘칠 수 있는 자리가 셋이다. **어느 것도 조용히 자르지 않는다.**
 *
 * - 전사문이 에이전트 입구 상한(기본 512KB)을 넘었다 → 413.
 * - 적어 주신 쪽지가 길어 모델 제약 안내를 밀어낸다 → 413. 그 안내가 있어야
 *   에이전트가 못 알아들은 자리를 지어내지 않고 표시한다.
 * - 세션 맥락이 상한에 닿았다 → 409. 새 세션으로 옮기거나 맥락을 새로 시작한다.
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
  /*
   * 전사가 도는 중이면 거절한다.
   *
   * 다듬기는 상태를 `polishing` 으로 옮기는데, 그러면 워커가 보내는 진행이
   * 갈 곳을 잃는다 (`setRecordingState(..., ["transcribing"])` 이 0줄을
   * 고친다). 화면에는 진행 막대가 멎은 채로 남고, 전사가 끝나면서 상태를
   * 다시 덮어 다듬기가 통째로 사라진다. 재료가 아직 다 없기도 하다.
   */
  if (row.state === "queued" || row.state === "extracting" || row.state === "transcribing") {
    return NextResponse.json(
      { error: "아직 옮겨 적는 중입니다. 끝나면 저절로 다듬습니다.", recording: toRecordingDTO(row) },
      { status: 409 },
    );
  }
  /*
   * 화자를 나누는 중에도 거절한다. 위와 같은 까닭이다 — 상태를 `polishing`
   * 으로 옮기면 분리가 끝나며 상태를 되돌릴 때(`setRecordingState(..., "done")`)
   * 다듬기가 통째로 덮여 사라진다. 그리고 재료가 아직 다 없다: 다듬기는
   * 화자 이름이 붙은 전사문을 읽어야 군집에 이름을 달 수 있다.
   */
  if (row.state === "diarizing") {
    return NextResponse.json(
      {
        error: "누가 말했는지 가르는 중입니다. 끝나면 저절로 다듬습니다.",
        recording: toRecordingDTO(row),
      },
      { status: 409 },
    );
  }
  if (countSegments(id) === 0) {
    return NextResponse.json(
      { error: "다듬을 전사문이 아직 없습니다" },
      { status: 409 },
    );
  }

  /*
   * 모양이 어긋나면 **거절한다.** 조용히 버리지 않는다.
   *
   * 전에는 `parsed.success` 가 아니면 쪽지를 `undefined` 로 두고 그대로
   * 다듬었다. 그러면 상한(2,000자)을 넘게 적은 사람은 202 를 받고 "쪽지가
   * 반영된 다듬기" 를 기다리는데, 실제로는 쪽지 없이 돈다. 무엇이 빠졌는지
   * 화면 어디에도 안 뜬다 — 이 앱이 다른 자리마다 피하는 바로 그 실패다.
   */
  const parsed = bodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "적어 주신 쪽지를 쓸 수 없습니다 (2,000자까지). 잘라 보내면 적으신 " +
          "그대로 갔다고 믿게 되므로 보내지 않았습니다.",
        code: "invalid-body",
      },
      { status: 400 },
    );
  }
  const context = parsed.data.context;

  try {
    const started = await queuePolish(id, context ?? null);
    logAgent(req, "전사문 다듬기 요청", row.title, {
      jobId: started.jobId,
      queued: started.queued,
      hasContext: !!context,
      sessionId: row.sessionId,
    });

    const after = getRecordingRow(id)!;
    return NextResponse.json(
      {
        jobId: started.jobId,
        queued: started.queued,
        aheadInSession: started.aheadInSession,
        recording: withSession(after, sessionOfRecording(after)?.name ?? null),
      },
      { status: 202 },
    );
  } catch (e) {
    if (e instanceof TranscriptTooLargeError) {
      // 자르지 않았다는 말을 그대로 화면에 넘긴다.
      return NextResponse.json(
        { error: e.message, code: "transcript-too-large", bytes: e.bytes, limit: e.limit },
        { status: 413 },
      );
    }
    if (e instanceof PolishContextTooLongError) {
      return NextResponse.json(
        { error: e.message, code: "context-too-long", over: e.over },
        { status: 413 },
      );
    }
    if (e instanceof PolishBusyError) {
      // 위의 검사와 여기 사이로 둘이 나란히 들어온 경우다. 답은 같다.
      return NextResponse.json({ error: e.message, jobId: null }, { status: 409 });
    }
    if (e instanceof AgentSessionFullError) {
      /*
       * 저쪽 세션이 먼저 찼다. 우리 눈금은 아직 여유로울 수 있지만(세는
       * 방법이 다르다) 사람이 할 일은 같다 — 새 세션으로 옮기거나 이 세션의
       * 맥락을 새로 시작한다. 그래서 갈래도 같게 올려 보낸다. 저쪽 문장을
       * 그대로 쓴다: 무엇을 하면 되는지 거기 적혀 있다.
       */
      const s = sessionOfRecording(row);
      return NextResponse.json(
        {
          error: e.message,
          code: "session-context-full",
          session: s ? toSessionDTO(s) : null,
        },
        { status: 409 },
      );
    }
    if (e instanceof SessionContextFullError) {
      /*
       * 409 다 — 요청이 틀린 것이 아니라 지금 상태로는 못 하는 것이다.
       * 무엇을 하면 되는지 함께 싣는다: 새 세션으로 옮기거나 이 세션의
       * 맥락을 새로 시작한다 (`POST /api/sessions/[id]/rollover`).
       */
      return NextResponse.json(
        {
          error: e.message,
          code: "session-context-full",
          session: toSessionDTO(e.session),
        },
        { status: 409 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message },
      { status: e instanceof AgentUnavailableError ? 502 : 500 },
    );
  }
}

/**
 * 도는 중인 다듬기를 물어본다. **물어보는 것이 진행을 민다.**
 *
 * 서버 타이머만 두면 프로세스가 다시 뜰 때 진행 중이던 것이 영영
 * `polishing` 으로 남는다. 화면이 물어볼 때마다 한 걸음 밀어 두면 그런
 * 일이 없다. 창을 닫고 가는 사람을 위해 줄을 잡은 쪽도 함께 민다 — 둘 다
 * 상태를 조건으로 건 UPDATE 라 두 번 반영되지 않는다.
 *
 * 줄을 서 있는 동안에는 `jobId` 가 없고, 그때 `advancePolish` 는 아무 일도
 * 하지 않는다 (아직 저쪽에 물어볼 것이 없다).
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
    recording: withSession(row, sessionOfRecording(row)?.name ?? null),
    jobId: row.polishJobId,
    /** 줄에 서 있나. `polishing` 인데 번호가 없으면 그렇다. */
    queued: row.state === "polishing" && !row.polishJobId,
    error: row.polishError,
    agent: agentReady(),
  });
}
