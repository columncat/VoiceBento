"use client";

import { Info, TriangleAlert } from "lucide-react";

import type { RecordingNoticeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import type { ModelCapability } from "./model-capability";

/**
 * **이 모델이 무엇을 알아듣고 무엇을 못 알아듣는가.**
 *
 * ## 왜 이 말이 화면에 있어야 하나
 *
 * 지금 물려 있는 모델(`parakeet-tdt-0.6b-v3`)의 어휘에는 한글이 하나도 없다.
 * 한국어를 넣으면 오류가 나지 않는다 — 빈 글이나 엉뚱한 로마자가 나오고,
 * 더 나쁘게는 **그럴듯한 영어가 지어져** 나온다. 오류가 났다면 사람이 알아서
 * 알아채겠지만, 아무 일도 없었던 것처럼 결과가 나오면 사람은 파일이 잘못된
 * 줄 알고 같은 것을 몇 번씩 다시 올린다.
 *
 * ## 말은 **서술자에서** 온다
 *
 * 전에는 이 파일에 언어 목록과 "한국어를 못 합니다" 라는 문장이 박혀 있었다.
 * 모델을 갈아 끼우는 날 여기만 옛말로 남는다. 지금은 서버가 실어 주는 모델
 * 서술자(`readModel()` 이 읽는 것)에서 전부 나온다 — **한국어를 되는 모델을
 * 붙이면 이 경고가 저절로 사라진다.** 그것이 "준비해 놓는다" 의 뜻이다.
 *
 * ## 과장하지도 숨기지도 않는다
 *
 * "한국어 지원 안 함" 만 크게 써 두면 이 앱이 못 쓰는 물건처럼 보인다. 실제로는
 * 유럽어 25개를 잘 알아듣는다. 그래서 **할 수 있는 것과 못 하는 것을 한 문장
 * 안에 나란히** 둔다. 경고색은 못 하는 쪽에만 쓴다.
 */

/**
 * `**굵게**` 를 진짜 굵은 글자로.
 *
 * 서버가 만든 안내 문장에는 강조가 섞여 있다 (`model.ts` 의 `buildNotice`).
 * 그대로 적으면 별표가 글자로 나오고, 별표를 지우면 **어디가 중요한지**가
 * 사라진다 — 그 문장에서 굵은 데가 정확히 "한국어를 알아듣지 못합니다" 다.
 *
 * `rich-text.tsx` 를 부르지 않는다. 그 파일은 네 앱에 바이트까지 같은 채로
 * 있고 여기서 쓰기 시작하면 갈라진다. 게다가 저것은 에이전트가 지어낸 글을
 * 그리는 물건이라 훨씬 많은 일을 한다 — 여기 오는 글은 우리가 만든 한 문장이다.
 */
function Emphasized({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*/).map((part, i) =>
        // 홀수 칸이 별표 **사이**다. 별표가 짝이 안 맞으면 마지막 조각이
        // 그냥 보통 글자로 나온다 — 문장이 깨지지 않는 쪽으로 넘어간다.
        i % 2 === 1 ? (
          <b key={i} className="font-semibold">
            {part}
          </b>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * 전사문이 비었거나 이상할 때, 그 자리에 대신 놓는 말.
 *
 * 서버가 무엇을 알아챘는지(`RecordingNoticeDTO`)에 따라 말이 달라진다. 소리는
 * 긴데 글이 거의 없으면 이 모델이 모르는 말일 가능성이 가장 크지만, 말이 아닌
 * 소리(음악, 잡음)였을 수도 있다. **둘을 뭉뚱그리지 않는다** — 사람이 다음에
 * 할 일이 다르다.
 */
export function EmptyTranscriptNotice({
  notice,
  cap,
  className,
}: {
  notice: RecordingNoticeDTO | null;
  cap: ModelCapability;
  className?: string;
}) {
  /*
   * "모르는 말이었을 수 있다" 쪽인가.
   *
   * 서버가 `mostly-empty` 라고 콕 집었을 때만 아니다. 그 밖에는 언어를
   * 의심한다 — 다만 **모델이 이 화면의 말을 알아듣는다면** 그 의심이 틀렸다.
   * 한국어 되는 모델을 붙인 날 "한국어를 못 합니다" 가 남아 있으면 안 된다.
   */
  const language = notice?.kind !== "mostly-empty" && !cap.understandsUiLanguage;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[var(--radius-card)] bg-(--color-surface) p-6 ring-1 ring-(--color-border-soft)",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 shrink-0 text-(--color-warn)" />
        <h2 className="text-sm font-medium text-(--color-fg)">
          {language ? "이 모델이 모르는 말일 수 있습니다" : "옮길 말을 찾지 못했습니다"}
        </h2>
      </div>

      {/* 서버가 문장을 실어 줬으면 그것을 먼저 적는다. 이 녹음을 실제로 본 쪽의 말이다. */}
      {notice?.text && (
        <p className="text-[12.5px] leading-relaxed break-keep text-(--color-fg-2)">{notice.text}</p>
      )}

      <p className="text-[12.5px] leading-relaxed break-keep text-(--color-fg-3)">
        {language ? (
          <>
            전사 모델 <span className="font-mono text-[11.5px]">{cap.name}</span> 은(는){" "}
            {cap.languageLong}를 알아듣습니다. <Emphasized text={cap.notice} />
          </>
        ) : (
          "소리는 있는데 말로 들리는 대목이 없었습니다."
        )}
      </p>
    </div>
  );
}

/**
 * 모델 출처.
 *
 * 장식이 아니라 **의무다.** 지금 물려 있는 가중치
 * `nvidia/parakeet-tdt-0.6b-v3` 는 CC-BY-4.0 이라 출처를 밝혀야 한다. 문장은
 * 서술자가 들고 온다 — 모델을 갈아 끼우면 지켜야 할 라이선스도 바뀌는데,
 * 화면에 박아 두면 옛 출처를 계속 밝히게 된다.
 */
export function ModelCredit({ cap, className }: { cap: ModelCapability; className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-[10.5px] text-(--color-fg-4)", className)}>
      <Info className="h-3 w-3 shrink-0" />
      <span className="break-keep">{cap.attribution}</span>
    </p>
  );
}
