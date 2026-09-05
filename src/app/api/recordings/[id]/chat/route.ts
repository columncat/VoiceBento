import { NextResponse } from "next/server";
import { z } from "zod";

import { CHAT_CONTEXT_CHARS, chatContext } from "@/lib/agent";
import { getRecordingRow } from "@/lib/recording-server";

/**
 * 녹음 하나를 두고 나누는 대화 — BentoAgent 로 가는 프록시.
 *
 * 브라우저는 에이전트를 직접 부르지 않는다. 공유 토큰이 화면에 실리면 안 되고,
 * 이 앱에 이미 있는 로그인을 그대로 경계로 쓰고 싶다. 미들웨어가 이 경로를
 * 지키므로 로그인하지 않으면 여기까지 오지 못한다.
 *
 * ## 요약·다듬기와 다른 길이다
 *
 * 저 둘은 한 번 부르고 끝나는 일회성 호출이다. 대화는 녹음마다 세션이
 * 이어진다 (`recordingId` 가 늘 함께 간다) — 다른 녹음 이야기와 Discord
 * 대화가 한 자루에 섞이면 "이 녹음에 대해" 라는 말이 뜻을 잃는다.
 *
 * **셋 다 도구가 없다** (BentoAgent 쪽 `tools: []`). 재료가 남이 만든 소리를
 * 받아 적은 글이라, 도구가 달린 세션에 넣으면 그 글이 곧 도구 호출이 될 수
 * 있기 때문이다. 그래서 대화도 전사문을 **본문에 실어** 보낸다 — 아래 POST
 * 를 보라. 안 실으면 에이전트는 아무것도 모르는 채로 답을 지어낸다.
 *
 * ## 오래 걸리는 일이라 시작과 끝이 다른 요청이다
 *
 * POST 로 시작만 시키고 번호를 받는다. GET `?job=` 으로 몇 초마다 물어본다.
 * 답을 기다리며 요청을 붙들면 앞의 Cloudflare 터널이 100초에서 끊는다 —
 * MemoBento 채팅창이 그렇게 겪었고 화면에는 "failed to fetch" 만 떴다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AGENT_URL = process.env.AGENT_URL?.trim();
const AGENT_TOKEN = process.env.AGENT_TOKEN?.trim();

/** 시작·상태 요청은 전부 금방 끝난다. 긴 연결이 없으니 넉넉할 이유가 없다. */
const TIMEOUT_MS = 15_000;

/** 주소를 잇는다. `new URL(path, base)` 는 base 의 경로를 버린다. */
function join(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * 부를 수 있는가.
 *
 * 판정은 `lib/agent.ts` 의 `agentReady()` 와 **같은 두 환경변수**다. 그
 * 모듈을 끌어오지 않고 여기서 제 자리에서 읽는 것은 프록시가 서버 모듈에
 * 기대지 않게 하려는 것이다 — 이 파일 하나만 보고도 무엇이 필요한지 안다.
 * 조건이 늘어나는 날에는 두 곳을 함께 봐야 한다.
 */
function readiness(): { ready: boolean; reason: string | null } {
  if (!AGENT_URL || !AGENT_TOKEN) {
    return {
      ready: false,
      reason:
        "에이전트가 설정되어 있지 않습니다 (AGENT_URL / AGENT_TOKEN). " +
        "그 둘이 들어오면 이 대화창이 저절로 켜집니다.",
    };
  }
  return { ready: true, reason: null };
}

/** 에이전트에게 그대로 넘기고 그대로 돌려준다. 토큰은 이 함수 안에서만 산다. */
async function relay(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(join(AGENT_URL!, path), {
      method: init.method,
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctl.signal,
    });
    const text = await res.text();
    return NextResponse.json(text ? JSON.parse(text) : {}, { status: res.status });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json(
      {
        error: aborted
          ? "에이전트가 제 시간에 답하지 않았습니다"
          : `에이전트에 닿지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}

const bodySchema = z.object({
  message: z.string().trim().max(8000).default(""),
  /**
   * 화면이 덧붙이는 짧은 쪽지 (선택).
   *
   * 전사문 자체는 **서버가 싣는다** (아래 POST). 이 칸은 사람이 "이건 면접
   * 녹음이다" 같은 것을 덧붙이고 싶을 때를 위한 자리다.
   */
  note: z.string().trim().max(2000).optional(),
});

/**
 * 지난 대화와 "지금 부를 수 있는가" 를 한 번에.
 *
 * 두 요청으로 가르지 않은 것은 대화창이 열릴 때 둘 다 필요하기 때문이다.
 * 닿지 못한 것도 `ready: false` 로 돌려준다 — 켜 두고 보낼 때 실패하는 것은
 * 없느니만 못하다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRecordingRow(id)) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  const agent = readiness();
  const job = new URL(req.url).searchParams.get("job");

  if (job) {
    if (!agent.ready) return NextResponse.json({ error: agent.reason, agent }, { status: 503 });
    // 404 는 그대로 통과시킨다. 화면이 "작업이 사라졌다" 로 알아본다.
    return relay(`/voice/status?id=${encodeURIComponent(job)}`, {
      method: "GET",
      timeoutMs: 10_000,
    });
  }

  if (!agent.ready) return NextResponse.json({ turns: [], agent });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(
      join(AGENT_URL!, `/voice/history?recordingId=${encodeURIComponent(id)}`),
      { headers: { authorization: `Bearer ${AGENT_TOKEN}` }, signal: ctl.signal },
    );
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as { turns?: unknown };
    return NextResponse.json({
      turns: Array.isArray(json.turns) ? json.turns : [],
      agent,
    });
  } catch (e) {
    // 설정은 됐는데 안 떠 있다. 이유가 다르므로 문장도 다르다.
    return NextResponse.json({
      turns: [],
      agent: {
        ready: false,
        reason: `에이전트에 닿지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 시작만 시키고 번호를 받는다. 끝은 `?job=` 으로 물어본다. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRecordingRow(id)) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }
  const agent = readiness();
  if (!agent.ready) return NextResponse.json({ error: agent.reason, agent }, { status: 503 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const { message, note } = parsed.data;
  if (!message) return NextResponse.json({ error: "보낼 것이 없습니다" }, { status: 400 });

  /*
   * **전사문을 매 턴 실어 보낸다.**
   *
   * 저쪽 대화에는 도구가 하나도 없다 (`tools: []`). 이것을 안 보내면
   * 에이전트는 이 녹음에 무슨 말이 담겼는지 모르는 채로 답한다 — 그럴듯하지만
   * 전부 지어낸 답이 나오고, 사람은 그것을 알아챌 방법이 없다.
   * 매 턴 보내는 것은 저쪽 세션이 사라져 새로 열려도 조용히 잊지 않게 하려는
   * 것이기도 하다 (`lib/agent.ts` 의 `chatContext`).
   */
  const transcript = chatContext(id);
  const context = note ? `${transcript}\n\n(사람이 덧붙인 쪽지: ${note})` : transcript;

  /*
   * 넘치면 **조용히 자르지 않고 그렇다고 말한다.**
   *
   * 뒤를 잘라 보내면 에이전트는 잘린 줄 모르고 "그런 얘기는 없다" 고 답한다.
   * 없는 것과 우리가 안 보낸 것은 다른데 그 차이가 화면에서 사라진다.
   * (한 시간짜리가 4만 자쯤이라 실제로 걸리는 일은 드물다.)
   */
  if (context.length > CHAT_CONTEXT_CHARS) {
    return NextResponse.json(
      {
        error:
          `전사문이 너무 깁니다 (${context.length.toLocaleString()}자, 상한 ` +
          `${CHAT_CONTEXT_CHARS.toLocaleString()}자). 잘라서 보내면 에이전트가 ` +
          `못 본 대목을 "없다" 고 답하므로 보내지 않았습니다. 요약을 먼저 만들어 보세요.`,
        tooLarge: true,
      },
      { status: 413 },
    );
  }

  return relay("/voice", { method: "POST", body: { recordingId: id, message, context } });
}

/** 새 대화 — **이 녹음 것만** 지운다. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = readiness();
  if (!agent.ready) return NextResponse.json({ error: agent.reason, agent }, { status: 503 });
  return relay("/voice/reset", { method: "POST", body: { recordingId: id } });
}
