import { NextResponse } from "next/server";

import { CHUNK_SIZE, MemoBentoError, putChunk } from "@/lib/memobento";
import { loadSession } from "@/lib/upload-session";

/**
 * 조각 하나 받아 그대로 넘긴다.
 *
 * 조각 크기가 고정이라 저쪽은 번호에 크기를 곱해 오프셋을 잡는다 — 순서가
 * 뒤바뀌거나 재시도해도 같은 결과가 된다. 그래서 브라우저가 끊긴 자리부터
 * 다시 보내도 된다.
 *
 * 여기서 바이트를 디스크에 적지 않는다. 받아서 곧바로 저쪽으로 보낸다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const index = Number(url.searchParams.get("index"));

  if (!id || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "invalid params" }, { status: 400 });
  }

  const session = await loadSession(id);
  if (!session) {
    return NextResponse.json(
      { error: "업로드 세션을 찾을 수 없습니다 (만료되었을 수 있음)" },
      { status: 404 },
    );
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > CHUNK_SIZE) {
    return NextResponse.json(
      { error: `조각 크기가 잘못되었습니다 (${buf.byteLength} bytes)` },
      { status: 400 },
    );
  }

  try {
    await putChunk(session.remoteId, index, buf);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message },
      { status: e instanceof MemoBentoError ? 502 : 500 },
    );
  }

  return NextResponse.json({ ok: true, index });
}
