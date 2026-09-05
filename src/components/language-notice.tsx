"use client";

import { Info, Languages, TriangleAlert } from "lucide-react";

import type { ModelNoticeDTO, RecordingNoticeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * **이 모델은 한국어를 못 한다.**
 *
 * 쓰는 모델은 `nvidia/parakeet-tdt-0.6b-v3` 인데, 어휘 8,193개에 한글이 하나도
 * 없다. 한국어를 넣으면 오류가 나지 않는다 — 빈 글이나 엉뚱한 로마자가
 * 나온다. 그게 이 사실을 화면에 적어야 하는 이유다. 오류가 났다면 사람이
 * 알아서 알아채겠지만, **아무 일도 없었던 것처럼 빈 전사문이 나오면** 사람은
 * 파일이 잘못된 줄 알고 같은 것을 몇 번씩 다시 올린다.
 *
 * ## 과장하지도 숨기지도 않는다
 *
 * "한국어 지원 안 함" 만 크게 써 두면 이 앱이 못 쓰는 물건처럼 보인다. 실제로는
 * 유럽어 25개를 잘 알아듣는다. 그래서 **할 수 있는 것과 못 하는 것을 한 문장
 * 안에 나란히** 둔다. 경고색은 못 하는 쪽에만 쓴다.
 *
 * ## 말은 서버에서 온다
 *
 * 문구를 화면에 박아 두면 나중에 모델을 갈아 끼울 때 여기만 옛말이 남는다.
 * `GET /api/recordings` 가 `model` 을 실어 주고 화면은 그것을 적는다. 못 받은
 * 경우(옛 서버, 목록을 못 불러온 화면)를 위해 같은 뜻의 기본값을 들고 있다 —
 * **이 말이 화면에서 사라지는 것이 가장 나쁜 결과이기 때문이다.**
 */
export const FALLBACK_MODEL: ModelNoticeDTO = {
  name: "parakeet-tdt-0.6b-v3",
  languages: "영어·독일어·프랑스어·스페인어·이탈리아어·러시아어를 비롯한 유럽어 25개",
  koreanUnsupported: true,
  notice:
    "한국어는 알아듣지 못합니다. 한국어 오디오를 넣으면 오류 대신 빈 글이나 엉뚱한 로마자가 나옵니다.",
};

/** 목록에 실려 온 안내. 없으면 기본값. */
export function modelNotice(model: ModelNoticeDTO | null | undefined): ModelNoticeDTO {
  return model ?? FALLBACK_MODEL;
}

/**
 * 올리는 자리에 미리 적어 두는 한 줄.
 *
 * "올린 다음에" 가 아니라 **올리기 전에** 보여야 한다. 한 시간짜리 영상을
 * 20분 올린 뒤에 알게 되면 그 20분이 통째로 헛수고다.
 */
export function LanguageLine({
  model,
  className,
}: {
  model?: ModelNoticeDTO | null;
  className?: string;
}) {
  const m = modelNotice(model);
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg bg-(--color-bg-2) px-3 py-2 text-[11.5px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)",
        className,
      )}
    >
      <Languages className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-fg-4)" />
      <span className="min-w-0">
        {m.languages}를 알아듣습니다.{" "}
        {m.koreanUnsupported && (
          // 못 하는 쪽만 눈에 띄게. 굵게 + 경고색이라 색을 못 보는 눈에도 남는다.
          <b className="font-medium text-(--color-warn)">{m.notice}</b>
        )}
      </span>
    </p>
  );
}

/**
 * 전사문이 비었거나 이상할 때, 그 자리에 대신 놓는 말.
 *
 * 서버가 무엇을 알아챘는지(`RecordingNoticeDTO`)에 따라 말이 달라진다. 소리는
 * 긴데 글이 거의 없으면 한국어일 가능성이 가장 크지만, 말이 아닌 소리(음악,
 * 잡음)였을 수도 있다. **둘을 뭉뚱그리지 않는다** — 사람이 다음에 할 일이 다르다.
 */
export function EmptyTranscriptNotice({
  notice,
  model,
  className,
}: {
  notice: RecordingNoticeDTO | null;
  model?: ModelNoticeDTO | null;
  className?: string;
}) {
  const m = modelNotice(model);
  const korean = notice?.kind !== "mostly-empty";

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
          {korean ? "이 모델은 한국어를 못 합니다" : "옮길 말을 찾지 못했습니다"}
        </h2>
      </div>

      {/* 서버가 문장을 실어 줬으면 그것을 먼저 적는다. 이 녹음을 실제로 본 쪽의 말이다. */}
      {notice?.text && (
        <p className="text-[12.5px] leading-relaxed break-keep text-(--color-fg-2)">{notice.text}</p>
      )}

      <p className="text-[12.5px] leading-relaxed break-keep text-(--color-fg-3)">
        {korean ? (
          <>
            전사 모델 <span className="font-mono text-[11.5px]">{m.name}</span> 은 {m.languages}를
            알아듣습니다. 한국어는 목록에 없어서, 한국어 오디오를 넣으면 오류가 나는 대신{" "}
            <b className="font-medium text-(--color-fg-2)">빈 글이나 엉뚱한 로마자</b>가 나옵니다.
            지금 화면이 비어 있는 것은 그 때문일 수 있습니다.
          </>
        ) : (
          <>
            소리는 있는데 말로 들리는 대목이 없었습니다. 음악·잡음만 담긴 파일이거나, 목소리가
            너무 작아 묻힌 경우입니다. 다른 파일로 다시 해 보세요.
          </>
        )}
      </p>

      <p className="text-[11.5px] leading-relaxed break-keep text-(--color-fg-4)">
        {/*
          할 수 있는 일을 함께 적는다. "안 됩니다" 만 있고 다음 수가 없으면
          사람은 같은 파일을 한 번 더 올린다.
        */}
        유럽어로 된 녹음이라면 잘 됩니다. 파일이 잘못된 것 같으면 원본을 재생해 보고, 소리가
        제대로 들리는데도 이 화면이 나오면 다시 전사를 눌러 보세요.
      </p>
    </div>
  );
}

/**
 * 모델 출처.
 *
 * 장식이 아니라 **의무다.** 원본 가중치 `nvidia/parakeet-tdt-0.6b-v3` 는
 * CC-BY-4.0 이라 출처를 밝혀야 한다. 이 앱은 공개 저장소가 될 것이므로
 * README 에만 적어 두고 화면에서 빼면 쓰는 사람은 영영 못 본다.
 */
export function ModelCredit({ model, className }: { model?: ModelNoticeDTO | null; className?: string }) {
  const m = modelNotice(model);
  return (
    <p className={cn("flex items-center gap-1.5 text-[10.5px] text-(--color-fg-4)", className)}>
      <Info className="h-3 w-3 shrink-0" />
      <span className="break-keep">
        전사: NVIDIA <span className="font-mono">{m.name}</span> (CC BY 4.0) · sherpa-onnx
        (Apache-2.0)
      </span>
    </p>
  );
}
