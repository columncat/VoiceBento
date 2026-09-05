import { notFound } from "next/navigation";

import { TranscriptView } from "@/components/transcript-view";
import { env } from "@/lib/env";
import { getRecordingRow } from "@/lib/recording-server";

/**
 * 전사문 한 편.
 *
 * 여기서는 **있는지만 본다.** 전사문 본문은 `<TranscriptView>` 가 붙자마자
 * 받아 온다 — 전사가 도는 동안에는 몇 초마다 다시 물어봐야 하고, 그건 어차피
 * 브라우저 쪽 일이라 서버에서 한 벌 더 실어 보낼 이유가 없다.
 *
 * 그래도 없는 id 는 여기서 막는다. 빈 화면 대신 404 를 준다 — 주소를 잘못
 * 눌렀을 때 "요약을 적으세요" 가 떠 있으면 어디에 적히는지 알 수 없다.
 */
export const dynamic = "force-dynamic";

export default async function RecordingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!getRecordingRow(id)) notFound();

  return (
    <TranscriptView
      recordingId={id}
      mailbentoUrl={env.MAILBENTO_URL?.trim() || null}
      memobentoUrl={env.MEMOBENTO_URL?.trim() || null}
      paperbentoUrl={env.PAPERBENTO_URL?.trim() || null}
    />
  );
}
