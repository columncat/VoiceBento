"use client";

import { AlertTriangle, Check, Clock, Loader2 } from "lucide-react";

import type { JobState, RecordingDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { estimateWork } from "./format";

/**
 * "지금 무엇을 하는 중인가" 를 한 자리에서 말한다.
 *
 * 목록 카드와 전사문 화면 머리말이 같은 문구를 써야 한다. 두 곳에 따로 적어
 * 두면 단계 이름 하나를 고칠 때 한쪽만 바뀌고, 사람은 목록에서 본 말과 들어가
 * 본 말이 다른 것을 곧바로 알아챈다.
 *
 * ## 단계 이름은 기계 말이 아니라 사람 말로
 *
 * `extracting` 을 "추출 중" 이라고 적으면 무엇을 추출하는지가 없다. 여기서
 * 일어나는 일은 **영상에서 소리만 뽑아내는 것**이고, 그게 몇 분 걸릴 수도
 * 있다는 사실이 화면에 있어야 사람이 기다린다.
 */

export const STATE_LABEL: Record<JobState, string> = {
  queued: "차례 기다리는 중",
  extracting: "오디오 뽑는 중",
  transcribing: "전사 중",
  diarizing: "화자 나누는 중",
  polishing: "다듬는 중",
  done: "전사 끝",
  failed: "실패",
};

/** 한 줄 설명. 처음 쓰는 사람에게 이 단계가 무엇인지 말해 준다. */
export const STATE_HINT: Record<JobState, string> = {
  queued: "앞의 전사가 끝나면 시작합니다",
  extracting: "영상에서 소리만 꺼내 16kHz 로 맞추는 중입니다",
  transcribing: "말소리를 글자로 옮기는 중입니다",
  /*
   * **전사문은 이미 다 나왔다.** 그 사실을 적는 것이 이 문구의 값이다 —
   * 60분짜리면 여기서 7~9분이 더 걸리는데, 그동안 아무 말이 없으면 사람은
   * 아직 옮겨 적는 중인 줄 알고 기다린다.
   */
  diarizing: "전사문은 다 나왔습니다. 이제 누가 말했는지 소리로 가르는 중입니다",
  polishing: "에이전트가 문장을 다듬는 중입니다",
  done: "",
  failed: "",
};

/** 아직 도는 중인가. 화면이 다시 물어볼지를 이걸로 정한다. */
export function isBusy(state: JobState): boolean {
  return (
    state === "queued" ||
    state === "extracting" ||
    state === "transcribing" ||
    state === "diarizing" ||
    state === "polishing"
  );
}

/**
 * 진행률을 아는 단계인가.
 *
 * 전사만 안다 — 서버가 VAD 조각을 몇 개까지 디코딩했는지 셀 수 있다.
 * 오디오 뽑기는 ffmpeg 한 번이고, 다듬기는 에이전트가 얼마나 남았는지
 * 자기도 모른다.
 */
function hasPercent(r: RecordingDTO): boolean {
  return r.state === "transcribing" && typeof r.progress === "number";
}

export function StateBadge({ state, className }: { state: JobState; className?: string }) {
  const busy = isBusy(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap",
        state === "failed"
          ? "bg-(--color-danger)/15 text-(--color-danger)"
          : busy
            ? "bg-(--color-accent-soft) text-(--color-accent-strong)"
            : "bg-(--color-bg-2) text-(--color-fg-3)",
        className,
      )}
    >
      {/*
        상태를 색으로만 가르지 않는다. 아이콘 모양과 글자가 함께 바뀐다 —
        색만으로 나누면 흑백 화면과 색각 이상에서 "도는 중" 과 "실패" 가
        같은 회색 알약이 된다.
      */}
      {state === "failed" ? (
        <AlertTriangle className="h-3 w-3 shrink-0" />
      ) : state === "done" ? (
        <Check className="h-3 w-3 shrink-0" />
      ) : state === "queued" ? (
        <Clock className="h-3 w-3 shrink-0" />
      ) : (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      )}
      {STATE_LABEL[state]}
    </span>
  );
}

/**
 * 진행 막대 + 한 줄 설명.
 *
 * 전사는 60분짜리가 6분쯤 걸린다(uno 실측 RTF 0.096). 그 사이 아무 신호가
 * 없으면 사람은 창을 닫거나 한 번 더 올린다. 퍼센트를 아는 단계에서는
 * 퍼센트를, 모르는 단계에서는 **모른다는 것이 보이는 막대**를 쓴다.
 */
export function JobProgress({
  recording,
  rtf,
  diarRtf,
  className,
}: {
  recording: RecordingDTO;
  /** 모델 서술자의 실시간 대비 배수. 걸릴 시간을 이걸로 어림한다. */
  /** 모델을 재 본 적이 없으면 null·undefined 로 온다 — 그때는 어림을 안 적는다. */
  rtf?: number | null;
  /**
   * 화자 분리의 실시간 대비 배수. **전사의 것과 다른 값이다** (0.27 대 0.096).
   *
   * 서술자에서 와야 한다 (`DiarNoticeDTO.rtf`). 여기 박아 두면 임베딩 모델을
   * 갈아 끼우는 날 — 두 번째 칸(ERes2NetV2)은 RTF 가 4.8배다 — 이 어림만
   * 옛말로 남고, 그때 화면은 16분이라고 적은 채 한 시간을 돌린다.
   */
  diarRtf?: number | null;
  className?: string;
}) {
  if (!isBusy(recording.state)) return null;

  const pct = hasPercent(recording)
    ? Math.max(0, Math.min(100, Math.round((recording.progress ?? 0) * 100)))
    : null;
  /*
   * 걸릴 시간 어림. **진행 막대는 못 그린다** — 분리 워커는 중간 산출을
   * 안 낸다 (구간이 다 나온 뒤에 한꺼번에 온다). 그래서 도는 중이라는 것과
   * 얼마나 걸리는지, 둘만 말한다.
   */
  const eta =
    recording.state === "transcribing"
      ? estimateWork(recording.duration, rtf, 0.1)
      : recording.state === "diarizing"
        ? estimateWork(recording.duration, diarRtf, 0.27)
        : null;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-(--color-fg-2)">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-(--color-accent)" />
          <span className="truncate">{STATE_LABEL[recording.state]}</span>
        </span>
        {pct !== null && (
          <span className="shrink-0 font-mono text-[10.5px] text-(--color-fg-3)">{pct}%</span>
        )}
      </div>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-(--color-bg-2)"
        role="progressbar"
        aria-label={STATE_LABEL[recording.state]}
        // 퍼센트를 모르면 `aria-valuenow` 를 아예 안 준다. 그게 낭독기에
        // "진행률 미정" 을 뜻하는 표준 표시다. 0 을 넣으면 "0% 진행" 이 된다.
        {...(pct !== null ? { "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 } : {})}
      >
        {pct !== null ? (
          <div
            className="h-full rounded-full bg-(--color-accent) transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="bar-indeterminate h-full w-1/4 rounded-full bg-(--color-accent)" />
        )}
      </div>

      <p className="text-[10.5px] break-keep text-(--color-fg-4)">
        {STATE_HINT[recording.state]}
        {/*
          걸릴 시간은 **어림이라고 적어** 둔다. uno 한 대에서 잰 값이고 동시에
          두 건이 돌면 그만큼 늘어난다. 정확한 척하면 지나갔을 때 고장으로 보인다.
        */}
        {eta &&
          (recording.state === "diarizing"
            ? ` · 이 단계에 ${eta} 걸립니다`
            : ` · 전부 ${eta} 걸립니다`)}
      </p>
    </div>
  );
}
