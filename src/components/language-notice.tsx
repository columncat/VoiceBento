"use client";

import { ChevronDown, Info, Languages, MousePointerClick, TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { RecordingNoticeDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { languageNames, type ModelCapability } from "./model-capability";

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
 * 알아듣는 말을 다 펼쳐 보는 자리.
 *
 * 접어 두는 것은 25개가 한 줄에 안 들어가기 때문이고, **펼친 뒤에야 그리는**
 * 것은 코드를 이름으로 옮기는 `Intl` 의 자료가 서버(Node)와 브라우저에서
 * 판본이 다를 수 있어서다. 서버가 그린 글자와 브라우저가 그린 글자가
 * 어긋나면 하이드레이션이 깨진다 — 열기 전에는 아무것도 안 그리면 그 일이
 * 아예 안 생긴다.
 */
function LanguageList({ codes }: { codes: string[] }) {
  const [open, setOpen] = useState(false);
  if (codes.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 rounded text-(--color-fg-4) underline decoration-dotted underline-offset-2 transition hover:text-(--color-fg-2)"
      >
        {open ? "접기" : `${codes.length}개 모두 보기`}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <span className="mt-1 block text-[11px] leading-relaxed break-keep text-(--color-fg-4)">
          {languageNames(codes).join(" · ")}
        </span>
      )}
    </>
  );
}

/**
 * 서버에서 모델 정보를 못 받았다는 표시.
 *
 * 없으면 안 되는 줄이다. 기본값은 **지금 물려 있는 모델의 사실**이라,
 * 한국어 되는 모델로 갈아 끼운 뒤 목록 요청이 실패하면 "한국어를 못 합니다"
 * 가 거짓말이 된다. 그때 이 한 줄이 있어야 사람이 의심할 수 있다.
 */
function StaleMark({ cap }: { cap: ModelCapability }) {
  if (cap.fromServer) return null;
  return (
    <span className="text-(--color-fg-4)"> (모델 정보를 못 받아 기본값으로 적습니다)</span>
  );
}

/**
 * 올리는 자리에 미리 적어 두는 한 줄.
 *
 * "올린 다음에" 가 아니라 **올리기 전에** 보여야 한다. 한 시간짜리 영상을
 * 20분 올린 뒤에 알게 되면 그 20분이 통째로 헛수고다.
 */
export function LanguageLine({ cap, className }: { cap: ModelCapability; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg bg-(--color-bg-2) px-3 py-2 text-[11.5px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)",
        className,
      )}
    >
      <p className="flex items-start gap-2">
        <Languages className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-fg-4)" />
        <span className="min-w-0">
          <span className="font-mono text-[11px] text-(--color-fg-4)">{cap.name}</span> 은(는){" "}
          {cap.languageSummary}를 알아듣습니다.{" "}
          {!cap.understandsUiLanguage && (
            // 못 하는 쪽만 눈에 띄게. 굵게 + 경고색이라 색을 못 보는 눈에도 남는다.
            <b className="font-medium text-(--color-warn)">
              <Emphasized text={cap.notice} />
            </b>
          )}
          <StaleMark cap={cap} />{" "}
          <LanguageList codes={cap.languages} />
        </span>
      </p>
    </div>
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
            {cap.languageLong}를 알아듣습니다. <Emphasized text={cap.notice} /> 지금 화면이 비어
            있는 것은 그 때문일 수 있습니다.
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
        {cap.languageSummary}로 된 녹음이라면 잘 됩니다. 파일이 잘못된 것 같으면 원본을 재생해
        보고, 소리가 제대로 들리는데도 이 화면이 나오면 다시 전사를 눌러 보세요.
      </p>
    </div>
  );
}

/**
 * 이 모델이 시각을 얼마나 잘게 주는가.
 *
 * `timestamps: "none"` 인 모델(sherpa-onnx 의 whisper 갈래가 실제로 그렇다)
 * 에서는 낱말을 눌러도 갈 데가 없다. 그때 **낱말 클릭은 아예 접고** 이 줄로
 * 그 사실을 말한다 — 눌러 보고 아무 일도 안 일어나는 것을 몇 번 겪은 뒤에야
 * 안 된다는 것을 아는 것이 가장 나쁘다.
 *
 * 잘게 주는 모델에서는 아무 말도 안 한다. 되는 것을 자랑할 자리가 아니다.
 */
export function TimestampCapabilityLine({
  cap,
  className,
}: {
  cap: ModelCapability;
  className?: string;
}) {
  if (cap.wordClick) return null;
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg bg-(--color-bg-2) px-3 py-1.5 text-[11px] leading-relaxed break-keep text-(--color-fg-4) ring-1 ring-(--color-border-soft)",
        className,
      )}
    >
      <MousePointerClick className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0">
        이 모델은 낱말 단위 시각을 주지 않습니다. 줄 왼쪽의 시각이나 글을 누르면 그 줄이
        시작하는 대목부터 들을 수 있습니다.
      </span>
    </p>
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
