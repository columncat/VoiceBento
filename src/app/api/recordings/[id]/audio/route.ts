import { NextResponse } from "next/server";

import { MemoBentoError, openFile } from "@/lib/memobento";
import { getRecordingRow } from "@/lib/recording-server";

/**
 * 소리(영상) 흘려보내기 — MemoBento 의 파일 라우트로 가는 프록시.
 *
 * ## Range 를 **그대로** 실어 보내고 **그대로** 돌려준다
 *
 * `<audio>` 의 탐색(seek)은 전부 Range 로 이루어진다. 브라우저는 먼저 앞의
 * 몇 바이트를 받아 보고, 서버가 `Accept-Ranges: bytes` 와 206 을 제대로
 * 주는지 본다. 하나라도 빠지면 재생기는 **탐색 막대를 잠근다** — 되감기도
 * 앞으로 감기도 안 되고, 한 시간짜리 녹음에서 그건 못 쓰는 것이나 같다.
 * 전사문의 시각을 눌러 그 자리로 뛰는 것이 이 앱의 요점인데 그게 통째로 죽는다.
 *
 * MemoBento 의 파일 라우트는 그 대화를 제대로 한다 (`parseRange` · 416 ·
 * `Accept-Ranges` · 206 · `createReadStream({start,end})`). **우리가 할 일은
 * 중간에서 그것을 망치지 않는 것뿐이다.** 그래서
 *
 * - 요청의 `range` 를 그대로 넘기고,
 * - 응답의 상태 코드(200·206·416)를 그대로 쓰고,
 * - `Content-Range`·`Content-Length`·`Accept-Ranges`·`Content-Type` 을 그대로 옮기고,
 * - 몸통은 **읽지 않고** `res.body` 를 그대로 넘긴다.
 *
 * 마지막 것이 특히 중요하다. `await res.arrayBuffer()` 로 한 번 받아서
 * 다시 내보내면 한 시간짜리 영상이 서버 메모리에 통째로 올라온다.
 *
 * ## 왜 브라우저가 MemoBento 를 직접 부르지 않나
 *
 * 부를 수는 있지만 그러면 이 앱의 로그인 경계 밖으로 나간다. 그리고
 * MemoBento 쪽 세션이 따로 필요하다 — 두 앱이 같은 쿠키를 쓰는 배포에서는
 * 되지만, 그렇지 않은 배포에서는 조용히 안 된다. 여기서 프록시하면 어느
 * 배포에서든 같은 방식으로 돈다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 그대로 옮길 헤더. 여기 없는 것은 우리가 새로 정한다. */
const PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }
  if (!row.fileId) {
    return NextResponse.json({ error: "이 녹음에는 소리 파일이 없습니다" }, { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await openFile(row.fileId, req.headers.get("range"));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: message },
      { status: e instanceof MemoBentoError ? 502 : 500 },
    );
  }

  if (upstream.status === 404 || upstream.status === 410) {
    return NextResponse.json(
      { error: "소리 파일이 MemoBento 에 없습니다 (메모함에서 지워졌을 수 있습니다)" },
      { status: 410 },
    );
  }
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) {
    return NextResponse.json(
      { error: `MemoBento 가 파일을 주지 않았습니다 (${upstream.status})` },
      { status: 502 },
    );
  }

  const headers = new Headers();
  for (const name of PASS_THROUGH) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  /*
   * 저쪽이 `Accept-Ranges` 를 안 줬어도 우리가 붙인다.
   *
   * 그 라우트는 늘 주지만, 없을 때 브라우저가 탐색을 포기하는 손해가
   * 너무 커서 한 줄로 막아 둔다. 우리는 Range 를 그대로 넘기므로 이 약속은
   * 참이다.
   */
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  // 남의 계정으로 캐시되지 않게. 로그인 뒤에만 보이는 자료다.
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-content-type-options", "nosniff");

  // 416 은 몸통이 없다. `Content-Range: bytes */전체크기` 만 그대로 넘어간다.
  if (upstream.status === 416) {
    return new Response(null, { status: 416, headers });
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
