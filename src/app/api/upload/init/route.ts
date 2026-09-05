import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { CHUNK_SIZE, MemoBentoError, beginUpload, memobentoReady } from "@/lib/memobento";
import { createSession } from "@/lib/upload-session";

/**
 * 조각 올리기 시작 — 저쪽(MemoBento)에 자리를 잡고 번호 둘을 짝지어 둔다.
 *
 * 한 시간짜리 영상은 대개 몇 GB 다. 한 번에 받으면 본문 전체가 메모리에
 * 올라가고, 그 전에 앞의 Cloudflare 가 100MB 에서 끊는다 (무료 플랜). 그래서
 * 브라우저가 8MB 씩 잘라 보내고, 이 앱은 그 조각을 **그대로 MemoBento 로
 * 흘려보낸다** — 여기에는 바이트가 한 조각도 남지 않는다.
 *
 * 올릴 자리가 있는지 **먼저** 본다. 다 받고 나서 "메모함이 없다" 를 말하면
 * 몇 GB 를 헛되이 주고받은 뒤가 된다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  name: z.string().min(1).max(400),
  size: z.number().int().nonnegative(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { name, size } = parsed.data;

  const ready = memobentoReady();
  if (!ready.ready) {
    return NextResponse.json({ error: ready.reason }, { status: 503 });
  }

  const limit = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (size > limit) {
    return NextResponse.json(
      { error: `파일이 너무 큽니다 (최대 ${env.MAX_UPLOAD_MB}MB)` },
      { status: 413 },
    );
  }

  try {
    const remote = await beginUpload({ name, size });
    const session = await createSession({ remoteId: remote.uploadId, name, size });
    return NextResponse.json({
      uploadId: session.id,
      chunkSize: CHUNK_SIZE,
      chunks: size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE),
    });
  } catch (e) {
    // MemoBento 가 거절한 이유를 그대로 넘긴다 — "메모함이 없습니다" 같은
    // 말은 사람이 고칠 수 있는 유일한 실마리다.
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message },
      { status: e instanceof MemoBentoError ? 502 : 500 },
    );
  }
}
