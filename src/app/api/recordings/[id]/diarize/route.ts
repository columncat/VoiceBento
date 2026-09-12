import { existsSync } from "node:fs";

import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import { clusterCountFor } from "@/lib/diar-models";
import { diarModel, diarPaths } from "@/lib/env";
import {
  countSegments,
  getDiarizationRow,
  getRecordingRow,
  setRoster,
  toRecordingDTO,
} from "@/lib/recording-server";
import { dedupeRoster, requiredRoster } from "@/lib/roster-schema";
import { enqueueDiarize } from "@/lib/transcribe";

/**
 * **소리로 화자를 다시 나눈다.** 전사문은 손대지 않는다.
 *
 * 다시 전사(`…/retranscribe`)와 나란히 놓으면 다른 점이 분명하다. 저쪽은
 * 조각을 통째로 지우고 처음부터 옮겨 적는다 — 사람이 고친 줄까지 사라지므로
 * 화면이 먼저 물어봐야 한다. 이쪽은 조각의 글을 하나도 안 건드리고 **화자만**
 * 얹는다. 그래서 확인 없이 눌러도 된다.
 *
 * ## "잘못 눌러도 잃는 것이 없다" 가 참인 자리와 아닌 자리
 *
 * 그 말이 참이려면 세 문이 서 있어야 하고, 지금은 서 있다.
 *
 * - **글** — 조각의 `text`·`raw`·`edited` 를 안 쓴다. 다듬기도 다시 안 돌린다.
 * - **줄에서 고친 화자** — `human`, 그리고 0001 판에 `edited` 로만 남은 사람의
 *   화자를 `putSpeakerAssignments` 가 건너뛴다.
 * - **목소리에 붙인 이름** — 번호가 아니라 겹친 시간으로 옮긴다 (`saveDiarization`).
 *   예전에는 번호째 남아, 다시 나누면 이름이 **다른 목소리에** 앉았다.
 *
 * 참이 아닌 자리가 셋 남는다. 숨기지 않고 적는다.
 *
 * - 두 목소리가 한 군집으로 합쳐지거나 한 목소리가 반반으로 갈리면 그 군집의 이름을
 *   어디에도 옮기지 않는다 (`carryPlan`). 두 목소리가 섞였던 군집이 둘로 뚜렷하게
 *   갈라지면 **사람이 붙인** 이름은 옮기지 않는다. 사람 이름은 화면에 "다시 확인해
 *   주세요" 로 남는다.
 * - 옮기지 못한 **에이전트** 이름은 **버려지고, 이 길에서는 다시 붙지 않는다** — 여기는
 *   다듬기를 부르지 않는다(화자를 나눴다고 전사문 글자가 몰래 다시 다듬어지면 안
 *   된다). 그 목소리는 사람이 다듬기를 다시 누를 때까지 임시 이름("화자 N")으로 뜬다.
 *   섞였던 군집이 갈라진 경우의 에이전트 이름은 다수 목소리로 옮겨진다 — 잠기지 않은
 *   이름이라, 틀렸어도 다음 다듬기가 새 번호로 갈아 끼운다.
 * - 화자 신뢰도와 무리 수는 새 판의 것으로 바뀐다. 목록을 줄이면 이름을 받던
 *   목소리가 `other` 로 갈 수 있다 — 목록을 줄인 것이 곧 그 뜻이다.
 *
 * ## 목록을 여기서 받는다
 *
 * `k = 목록 인원 + 2` 다 (`clusterCountFor`). 그 `+2` 는 화면에 안 보인다 —
 * 사람에게 물어볼 값이 아니라 실측으로 정해진 값이라서다. 근거는
 * `diar-models.ts` 의 `clusterMargin` 에 적혀 있다 (k=L 로 주면 사용자의
 * 진짜 녹음에서 셋째 사람의 낱말 197개가 197개 전부 둘째 사람에게 붙었다).
 *
 * ## 목록은 **반드시** 받는다
 *
 * 한 명도 안 적으면 거절한다. 사람 수를 아예 안 주고 문턱으로 무리를 정하면
 * 진짜 회의에서 화자가 40~134명 나온다. "모르겠으면 비워 두세요" 를 열어
 * 두는 순간 그 길이 기본이 된다.
 *
 * 202 만 돌려준다. 60분짜리면 분리에 16분쯤 걸리고 (RTF 0.27), 그 앞에
 * 소리를 다시 받아 뽑는 시간이 얹힌다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/*
 * 목록의 모양(상한·문구)은 올리기와 같은 문을 지난다 (`lib/roster-schema.ts`).
 */
const bodySchema = z.object(
  {
    roster: requiredRoster(),
  },
  /*
   * 몸통 자체가 없거나(JSON 이 아니면 위에서 null 이 된다) 객체가 아닐 때의 문구.
   * 이것이 빠져 있어서 실제로 빈 몸통을 보내 보니 "Expected object, received null"
   * 이 영어 그대로 화면까지 갔다.
   */
  {
    required_error: "말한 사람을 적어도 한 명은 적어 주세요.",
    invalid_type_error: "말한 사람 목록이 없습니다.",
  },
);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = getRecordingRow(id);
  if (!row) {
    return NextResponse.json({ error: "녹음을 찾을 수 없습니다" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  // 같은 이름을 두 번 적은 것은 한 명으로 센다 (`dedupeRoster` 의 설명).
  const roster = dedupeRoster(parsed.data.roster);

  if (!row.fileId) {
    return NextResponse.json(
      { error: "이 녹음에는 소리 파일이 없어 화자를 나눌 수 없습니다" },
      { status: 409 },
    );
  }
  if (row.state !== "done") {
    /*
     * 전사가 아직 안 끝났거나 도는 중이다. **전사문이 화자 분리보다 먼저다** —
     * 그 규율이 여기서는 "먼저 끝나게 두라" 로 나온다. 올린 직후라면 파이프
     * 라인이 어차피 제 손으로 한 판 돌린다.
     */
    return NextResponse.json(
      {
        error:
          row.state === "failed"
            ? "전사가 실패한 녹음입니다. 먼저 다시 전사해 주세요."
            : "지금 다른 일이 돌고 있습니다. 끝나면 눌러 주세요.",
        recording: toRecordingDTO(row),
      },
      { status: 409 },
    );
  }
  if (countSegments(id) === 0) {
    return NextResponse.json(
      { error: "옮겨 적은 말이 없어 화자를 나눌 곳이 없습니다" },
      { status: 409 },
    );
  }
  if (!existsSync(diarPaths.seg) || !existsSync(diarPaths.emb)) {
    /*
     * 모델 파일이 없다. 줄을 세워 봐야 `whyNotDiarize` 가 같은 말을 하고
     * 건너뛴다 — 몇 분 기다린 뒤에 듣느니 지금 말하는 편이 낫다.
     */
    return NextResponse.json(
      { error: "화자 분리 모델이 아직 준비되지 않았습니다. 전사문은 그대로 나옵니다." },
      { status: 503 },
    );
  }

  setRoster(id, roster);
  enqueueDiarize(id);

  logAgent(req, "화자 나누기", row.title, {
    people: roster.length,
    clusters: clusterCountFor(diarModel, roster.length),
  });

  const after = getRecordingRow(id)!;
  return NextResponse.json(
    {
      recording: toRecordingDTO(after),
      /*
       * 지난 판을 **지우지 않고 그대로 실어 보낸다.** 새 결과가 앉을 때까지
       * 화면에는 옛 화자가 보이는 편이 낫다 — 몇 분 동안 이름이 사라졌다가
       * 돌아오면 그 사이에 무언가 잘못된 것처럼 보인다.
       */
      diarizing: getDiarizationRow(id) !== undefined,
    },
    { status: 202 },
  );
}
