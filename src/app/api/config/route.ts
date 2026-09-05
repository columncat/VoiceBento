import { NextResponse } from "next/server";
import { z } from "zod";

import { agentReady } from "@/lib/agent";
import { readConfig, writeConfig } from "@/lib/app-config";
import { env } from "@/lib/env";
import { memobentoReady } from "@/lib/memobento";
import { MODEL_NOTICE } from "@/lib/model";
import { queueDepth } from "@/lib/transcribe";

/**
 * 화면이 한 번에 물어보는 "이 앱은 지금 어떤 상태인가".
 *
 * 형제 앱 주소가 여기 있는 이유: 화면의 `CrossAppLink` 는 접속한 호스트에서
 * 주소를 유추하는데, **한 도메인을 경로로 나눠 쓰는 배포는 유추로 못 맞힌다**
 * (`bento.example.com/voice` 에서 `/memo` 로 가야 하는데 호스트만 봐서는
 * 경로를 모른다). 그 배포가 지금 우리 배포라 환경변수가 늘 이긴다.
 *
 * 못 쓰는 기능은 **왜 못 쓰는지**를 함께 준다. 켜 놓고 누를 때 실패하는 것은
 * 없느니만 못하다 — 사람은 파일이 이상한 줄 알고 같은 것을 다시 올린다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cfg = readConfig();
  return NextResponse.json({
    ...cfg,
    model: MODEL_NOTICE,
    agent: agentReady(),
    memobento: memobentoReady(),
    apps: {
      mailbento: env.MAILBENTO_URL ?? null,
      memobento: env.MEMOBENTO_URL ?? null,
      paperbento: env.PAPERBENTO_URL ?? null,
    },
    queue: queueDepth(),
    /** 동시에 몇 건까지 도는가. 화면이 "앞에 N건" 을 말할 때 쓴다. */
    concurrency: env.TRANSCRIBE_CONCURRENCY,
  });
}

const patchSchema = z.object({
  autoPolish: z.boolean().optional(),
  summaryPrompt: z.string().trim().max(4000).optional(),
});

export async function PATCH(req: Request) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  return NextResponse.json(writeConfig(parsed.data));
}
