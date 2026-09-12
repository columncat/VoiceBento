import { NextResponse } from "next/server";
import { z } from "zod";

import {
  CHAT_CONTEXT_CHARS,
  agentDiarFacts,
  agentModelBrief,
  chatContext,
  chatKey,
  spendChatContext,
} from "@/lib/agent";
import { getRecordingRow } from "@/lib/recording-server";
import { SessionContextFullError, toSessionDTO } from "@/lib/session-server";

/**
 * 녹음 하나를 두고 나누는 대화 — BentoAgent 로 가는 프록시.
 *
 * 브라우저는 에이전트를 직접 부르지 않는다. 공유 토큰이 화면에 실리면 안 되고,
 * 이 앱에 이미 있는 로그인을 그대로 경계로 쓰고 싶다. 미들웨어가 이 경로를
 * 지키므로 로그인하지 않으면 여기까지 오지 못한다.
 *
 * ## 대화는 **세션마다** 이어진다 (녹음마다가 아니라)
 *
 * 열쇠는 `sessionId` 칸으로 보낸다 (`chatKey`). 저쪽은 그 이름으로 claude
 * 세션을 잡으므로, 같은 세션의 두 녹음을 오가며 물어도 한 대화다. 그것이
 * "한 전사문은 한 세션에서 처리된다" 의 절반이다.
 *
 * **`recordingId` 칸에는 진짜 녹음 번호를 보낸다.** 한때 여기에도 세션 열쇠를
 * 실었다 — 저쪽이 `sessionId` 를 안 볼 때 그 칸이 유일한 열쇠였기 때문이다.
 * 이제는 보므로 되돌렸다. 되돌려야 하는 이유가 있다: 저쪽은 이 칸으로
 * 프롬프트 앞머리의 "지금 다루는 녹음" 을 적고, 세션에 붙은 녹음 수를 세고
 * (상한 20건), 화면 기록의 `about` 에 남긴다. 세션 열쇠를 넣으면 그 셋이
 * 전부 "세션 하나 = 녹음 하나" 로 보여 상한이 영영 안 걸리고, 지난 대화가
 * 어느 회차 얘기였는지 가릴 수 없게 된다.
 *
 * 세션이 없는 녹음은 예전 그대로 녹음 id 가 열쇠다 (`chatKey` 가 그렇게
 * 준다). 그래야 세션이 생기기 전에 쌓인 대화 기록이 고아가 되지 않는다.
 *
 * ## 요약·다듬기와 다른 길이다
 *
 * 요약은 도구도 세션도 없는 좁은 문(`/task`)으로 간다. 다듬기는 `/voice/polish`
 * 로 가고, 저쪽이 `sessionId` 를 보기 시작하면 이 대화와 같은 자루에서 돈다.
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
    /*
     * 기록도 **같은 열쇠로** 묻는다 (`sessionId`). 보내는 곳과 읽는 곳이 다른
     * 열쇠를 쓰면 방금 한 말이 창을 다시 열었을 때 안 보인다.
     */
    const res = await fetch(
      join(AGENT_URL!, `/voice/history?sessionId=${encodeURIComponent(chatKey(id))}`),
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

  /*
   * 세션 맥락을 **보내기 전에** 적어 둔다.
   *
   * 전사문을 매 턴 다시 싣기 때문에(저쪽에 도구가 없어서) 세션 기록은 한
   * 마디마다 전사문 하나만큼 길어진다. 녹음이 쌓이는 것보다 이쪽이 빨리
   * 자라는 일도 흔하다. 상한에 닿으면 **자르지 않고 거절한다** — 잘라 보내면
   * 에이전트가 앞부분을 잃은 줄 모른 채 "그런 얘기는 없습니다" 라고 답한다.
   *
   * 보내고 나서 세면 늦다. 그때는 이미 저쪽 세션에 들어간 뒤다.
   */
  try {
    spendChatContext(id, context.length + message.length);
  } catch (e) {
    if (e instanceof SessionContextFullError) {
      return NextResponse.json(
        { error: e.message, code: "session-context-full", session: toSessionDTO(e.session) },
        { status: 409 },
      );
    }
    throw e;
  }

  return relay("/voice", {
    method: "POST",
    body: {
      /** 진짜 녹음 번호. 저쪽이 앞머리에 적고, 세션의 녹음 수를 이걸로 센다. */
      recordingId: id,
      /** 대화가 이어질 자루. 같은 세션의 다듬기도 같은 열쇠로 돈다. */
      sessionId: chatKey(id),
      /**
       * 이 전사문을 만든 기계의 서술. **다듬기와 같은 것을 보낸다.**
       *
       * 둘이 한 세션에서 도는데 한쪽만 기계의 성질을 알면, 같은 자루 안에서
       * 앞뒤가 안 맞는 말을 하게 된다 — 다듬기는 "이 기계는 한국어를 모른다"
       * 로 표시해 두고 대화는 그 줄의 뜻을 짐작해 답하는 식으로.
       */
      model: agentModelBrief(),
      /**
       * 소리로 가른 화자에 대한 **사실.** 분리를 안 했으면 null.
       *
       * `model` 과 같은 자리에 있는 이유도 같다 — 다듬기와 대화가 한 세션에서
       * 도는데 한쪽만 화자가 소리로 갈린 것을 알면 앞뒤가 안 맞는 말을 한다.
       * 저쪽은 이것을 울타리 **밖**에 싣는다 (우리 DB 에서 센 숫자이지 남이
       * 만든 소리에서 나온 글이 아니다).
       *
       * 저쪽이 아직 이 칸을 모르는 판본이면 조용히 무시된다 — 그때는 예전처럼
       * 화자 이름을 그냥 읽고, 한계 문장만 덜 정확해진다. 깨지지는 않는다.
       */
      diar: agentDiarFacts(id),
      message,
      context,
    },
  });
}

/**
 * 새 대화 — **이 세션 것만** 지운다.
 *
 * 세션이 붙은 녹음이면 그 세션의 대화가 통째로 지워진다. 같은 세션의 다른
 * 녹음에서 나눈 말도 함께 사라진다는 뜻이다 — 그게 맞다. 하나의 자루이므로
 * 반만 지울 방법이 없고, 반만 지운 척하는 것이 더 나쁘다.
 *
 * 전사문·다듬은 결과·요약은 우리 DB 에 있으므로 하나도 안 잃는다.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = readiness();
  if (!agent.ready) return NextResponse.json({ error: agent.reason, agent }, { status: 503 });
  return relay("/voice/reset", { method: "POST", body: { sessionId: chatKey(id) } });
}
