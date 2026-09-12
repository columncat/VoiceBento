import { NextResponse } from "next/server";
import { z } from "zod";

import { logAgent } from "@/lib/agent-log";
import { diarModel } from "@/lib/env";
import {
  getDiarizationRow,
  getRecordingRow,
  listSegments,
  saveHumanDiarNames,
  toDiarizationDTO,
} from "@/lib/recording-server";

/**
 * **군집에 이름을 붙인다.** 줄 하나가 아니라 목소리 하나의 이름이다.
 *
 * ## 왜 줄 단위가 아닌가
 *
 * 같은 사람의 줄이 200개면 이름 하나를 고치는 데 200번을 고쳐야 한다. 그리고
 * 그중 하나를 빠뜨리면 같은 사람이 두 이름으로 앉는데, 그 어긋남은 전사문을
 * 끝까지 읽기 전에는 안 보인다.
 *
 * 이름은 조각에 박히지 않고 `diarizations.names` 표 한 칸에만 산다
 * (`speakerNamer`). 그래서 여기서 한 칸을 고치면 그 목소리의 모든 줄이
 * 함께 바뀐다.
 *
 * ## 줄 단위 고치기는 **없어진 것이 아니다**
 *
 * 한 줄만 사람이 잘못 붙은 것은 다른 일이고, 그건 `…/segments/[sid]` 가
 * 받는다. 그쪽은 그 줄에 `human` 을 찍어 **다시 나눠도 안 덮이게** 한다.
 * 둘은 뜻이 다르다 — 여기는 "이 목소리는 누구다", 저기는 "이 줄은 저 사람이
 * 아니다".
 *
 * ## 판이 다르면 **409** — 옛 번호의 초안을 막는다
 *
 * 몸통에 `run`(그 초안을 만든 판의 표지, `DiarizationDTO.run`)이 **반드시** 온다.
 * 화자 패널은 분리가 도는 동안에도 열려 있을 수 있고, 그 사이 다시 나누기가 끝나면
 * 군집 번호의 뜻이 바뀐다. 옛 판의 초안을 그대로 받으면 옛 번호의 이름이 새 판의
 * **다른 목소리**에 사람의 것으로 잠겨 앉는다 — 서버가 목소리를 따라 옮겨 둔 이름이
 * 화면 한 번의 저장으로 되돌아가는 길이다. 그래서 판을 서버가 확인한다
 * (`saveHumanDiarNames`). 화면만 믿으면 옛 탭 하나가 같은 일을 한다.
 *
 * 409 에는 새 판을 실어 준다. 화면은 그것으로 초안을 다시 맞추고, 사람이 적고 있던
 * 글자는 버리지 않고 "화자를 다시 나눴습니다, 이름을 확인해 주세요" 와 함께 보여 준다.
 *
 * ## 모르는 번호는 버린다
 *
 * `setDiarNames` 의 규칙이 `talkTime` 에 있는 번호만 남긴다. 판이 같아도 번호가 없는
 * 칸이 올 수 있고(손으로 만든 요청), 그 이름은 뜰 자리가 없다.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RUN_MISSING = "어느 화자 판에서 고친 이름인지 알 수 없습니다. 화면을 새로 고친 뒤 다시 저장해 주세요.";

const bodySchema = z.object({
  /** 이 초안을 만든 판 (`DiarizationDTO.run`). 지금 판과 다르면 409. */
  run: z.string({ required_error: RUN_MISSING, invalid_type_error: RUN_MISSING }).trim().min(1, RUN_MISSING),
  /**
   * 군집 번호 → 이름. 빈 문자열이면 그 번호의 이름을 **지운다**
   * (임시 이름 "화자 1" 로 돌아간다). 화면은 사람이 손댄 칸만 보낸다.
   */
  names: z.record(z.string(), z.string().trim().max(40, "이름이 너무 깁니다.")),
  /**
   * "다시 확인해 주세요" 목록에서 사람이 **뺀** 이름. 이 녹음에 없는 사람이라고 사람이
   * 판단한 것이다. 여기 오지 않은 이름은, 표에 붙이지 않았다면 목록에 그대로 남는다.
   */
  dismissRecheck: z.array(z.string().trim().max(40, "이름이 너무 깁니다.")).max(60).optional(),
});

export async function PATCH(
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
    /*
     * 까닭을 사람 말로 준다. zod 의 기본 문구("Required")가 그대로 화면에 뜨지 않게,
     * 판 표지가 빠진 것만 따로 말하고 나머지는 한 문장으로 묶는다.
     */
    const issue = parsed.error.issues[0];
    const message =
      issue?.path[0] === "run"
        ? RUN_MISSING
        : issue?.message === "이름이 너무 깁니다."
          ? issue.message
          : "이름 표 모양이 맞지 않습니다.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const names: Record<number, string> = {};
  for (const [k, v] of Object.entries(parsed.data.names)) {
    const n = Number(k);
    if (Number.isInteger(n)) names[n] = v;
  }

  const result = saveHumanDiarNames(id, {
    run: parsed.data.run,
    names,
    dismissRecheck: parsed.data.dismissRecheck,
  });

  if (result === "no-diarization") {
    return NextResponse.json(
      { error: "이 녹음은 아직 소리로 화자를 나누지 않았습니다", code: "no-diarization" },
      { status: 409 },
    );
  }

  const diar = getDiarizationRow(id);
  const diarization = diar ? toDiarizationDTO(diar, diarModel.fileWarnSilhouetteMedian) : null;

  if (result === "stale") {
    return NextResponse.json(
      {
        error:
          "화자를 다시 나눴습니다 — 이름을 확인해 주세요. 목소리 번호가 새로 매겨져 이번 저장은 반영하지 않았습니다.",
        code: "stale-diarization",
        diarization,
      },
      { status: 409 },
    );
  }

  logAgent(req, "화자 이름 붙이기", row.title, { clusters: Object.keys(names).length });

  return NextResponse.json({
    diarization,
    /*
     * 조각을 통째로 돌려준다. 이름 하나가 바뀌면 **그 목소리의 모든 줄**이
     * 바뀌므로, 화면이 무엇을 갈아 끼울지 스스로 셈하게 두면 이름 표와 줄이
     * 어긋나는 순간이 생긴다. 서버가 푼 이름을 그대로 받는 편이 안전하다.
     */
    segments: listSegments(id),
  });
}
