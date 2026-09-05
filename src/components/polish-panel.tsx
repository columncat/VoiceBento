"use client";

import { AlertTriangle, Loader2, Users, WandSparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { JobState, SegmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { formatBytes } from "./format";

/**
 * 다듬기 — 전사문을 에이전트에게 통째로 넘겨 문장을 고르게 하고 **화자를
 * 추정하게** 하는 자리.
 *
 * ## 왜 통째로 넘기나
 *
 * 화자는 화자 분리 모델이 아니라 **대사에서** 추정한다. "그건 제가
 * 확인해 볼게요" 다음에 "네, 부탁드립니다" 가 오면 두 사람이다 — 그런 판단은
 * 앞뒤를 다 봐야 선다. 조각을 나눠 보내면 경계마다 화자가 새로 시작해서,
 * 한 사람이 열두 명이 된다.
 *
 * ## 안 들어가면 **조용히 자르지 않는다**
 *
 * 에이전트 입구가 한 번에 받는 것은 512KB 다. 한 시간짜리 전사문은 글자로
 * 수만 자라 대개 그 안쪽이지만, 넘는 녹음이 언젠가 나온다. 그때 앞부분만
 * 잘라 보내면 **뒤쪽 절반이 화자 없이 남고** 사람은 그 사실을 모른다 —
 * 요약도 앞부분만 보고 쓴 것이 된다. 그래서 넘치면 아예 시작하지 않고,
 * 얼마나 넘쳤는지를 숫자로 적는다.
 *
 * 크기는 **여기서 미리 재서 보여 준다.** 서버도 같은 것을 봐야 하지만,
 * 눌러 보고 나서 "안 됩니다" 를 듣는 것보다 누르기 전에 아는 편이 낫다.
 *
 * ## 사람이 고친 줄은 안 덮는다
 *
 * 계약의 `edited` 다. 이걸 화면에 적어 두지 않으면, 다듬기를 다시 돌렸는데
 * 어떤 줄만 그대로인 것이 고장으로 보인다.
 */

/** 에이전트 입구가 한 번에 받는 크기. */
const AGENT_LIMIT = 512 * 1024;

/**
 * 서버가 에이전트에게 보낼 몸통을 그대로 만들어 재 본다.
 *
 * 모양은 계약서의 `POST {AGENT_URL}/voice/polish` 그대로다. 여기서 재는 값이
 * 서버가 실제로 보내는 것과 같아야 뜻이 있으므로, 칸을 늘리거나 줄이면 안 된다.
 */
function baseBytes(recordingId: string, segments: SegmentDTO[]): number {
  const body = JSON.stringify({
    recordingId,
    segments: segments.map((s, i) => ({ i, start: s.start, end: s.end, raw: s.raw })),
    context: "",
  });
  return new TextEncoder().encode(body).length;
}

/**
 * 맥락을 한 글자 칠 때마다 전사문 전체를 다시 문자열로 만들지 않는다.
 *
 * 한 시간짜리는 그 문자열이 수백 KB 다. 몸통에서 `context` 만 갈아 끼우는
 * 것이므로, 빈 문자열(`""` = 2바이트) 자리에 들어갈 값의 크기만 더하면 된다.
 * `JSON.stringify` 를 거치는 것은 따옴표와 이스케이프까지 세기 위해서다 —
 * 줄바꿈 하나가 `\n` 두 글자가 된다.
 */
function contextBytes(context: string): number {
  return new TextEncoder().encode(JSON.stringify(context)).length - 2;
}

export function PolishPanel({
  recordingId,
  segments,
  state,
  onRun,
  className,
}: {
  recordingId: string;
  segments: SegmentDTO[];
  state: JobState;
  /** 시작시키기. 진행은 녹음의 `state` 가 `polishing` 으로 바뀌며 보인다. */
  onRun: (context: string) => Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = useMemo(() => baseBytes(recordingId, segments), [recordingId, segments]);
  const bytes = base + contextBytes(context);
  const overflow = bytes > AGENT_LIMIT;

  const editedCount = segments.filter((s) => s.edited).length;
  const polishing = state === "polishing";
  const ready = state === "done" && segments.length > 0;
  const canRun = ready && !overflow && !starting;

  const run = async () => {
    setError(null);
    setStarting(true);
    try {
      await onRun(context.trim());
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "다듬기를 시작하지 못했습니다");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
        }}
        disabled={!ready && !polishing}
        aria-expanded={open}
        title={
          polishing
            ? "지금 다듬는 중입니다"
            : ready
              ? "에이전트가 문장을 다듬고 화자를 추정합니다"
              : "전사가 끝나야 다듬을 글이 생깁니다"
        }
        className={cn(
          "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ring-1 transition disabled:opacity-40",
          open
            ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40"
            : "bg-(--color-surface) text-(--color-fg-2) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
        )}
      >
        {polishing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <WandSparkles className="h-3.5 w-3.5" />
        )}
        {polishing ? "다듬는 중" : "다듬기 · 화자 추정"}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute top-full right-0 z-30 mt-2 w-[min(30rem,calc(100vw-3rem))] rounded-lg bg-(--color-surface-2) p-4 shadow-lg ring-1 ring-(--color-border-soft)">
            <header className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-(--color-fg-2)">
                <Users className="h-3.5 w-3.5 text-(--color-accent-strong)" />
                무슨 녹음인지 한 줄 적어 주세요
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={starting}
                aria-label="닫기"
                className="rounded-full p-1 text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2) disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>

            <p className="mb-2 text-[11px] leading-relaxed break-keep text-(--color-fg-4)">
              {/*
                맥락 한 줄이 결과를 크게 바꾼다. 사람 수와 이름을 알면 화자
                추정이 "화자 1·2" 대신 진짜 이름으로 나오고, 분야를 알면
                전문 용어의 철자가 맞는다. 비워도 되지만 왜 적으면 좋은지는
                말해 준다 — 안 그러면 아무도 안 적는다.
              */}
              참석자 수와 이름, 주제를 알면 화자 추정과 용어 교정이 크게 좋아집니다. 비워 두어도
              됩니다.
            </p>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              disabled={starting || polishing}
              rows={3}
              placeholder="예) 3월 14일 제품팀 주간 회의. 지수(팀장), 민호(개발), 서연(디자인) 셋이 참석."
              className="scrollbar-thin w-full resize-y rounded-md bg-(--color-surface) p-2.5 text-[11.5px] leading-relaxed text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
              aria-label="녹음 맥락"
            />

            <dl className="mt-3 flex flex-col gap-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-(--color-fg-4)">넘길 전사문</dt>
                <dd
                  className={cn(
                    "font-mono tabular-nums",
                    overflow ? "text-(--color-danger)" : "text-(--color-fg-3)",
                  )}
                >
                  {formatBytes(bytes)} / {formatBytes(AGENT_LIMIT)}
                </dd>
              </div>
              {editedCount > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-(--color-fg-4)">직접 고친 줄</dt>
                  <dd className="text-(--color-fg-3)">{editedCount}줄 — 그대로 둡니다</dd>
                </div>
              )}
            </dl>

            {overflow && (
              /*
                넘쳤다. **자르지 않는다** — 앞부분만 보내면 뒤쪽 절반이 화자
                없이 남고 사람은 그 사실을 모른다. 대신 무엇을 할 수 있는지를
                적는다.
              */
              <p className="mt-3 flex items-start gap-1.5 rounded-md bg-(--color-danger)/10 px-3 py-2 text-[11px] leading-relaxed break-keep text-(--color-danger) ring-1 ring-(--color-danger)/30">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">
                  전사문이 에이전트가 한 번에 받는 크기(512KB)를 {formatBytes(bytes - AGENT_LIMIT)}{" "}
                  넘습니다. <b className="font-medium">앞부분만 잘라 보내지 않습니다</b> — 그러면
                  뒷부분이 화자 없이 남고, 그 사실이 화면에 드러나지 않습니다. 녹음을 나눠 올린 뒤
                  각각 다듬어 주세요.
                </span>
              </p>
            )}

            {error && (
              <p className="mt-3 flex items-start gap-1.5 rounded-md bg-(--color-danger)/10 px-3 py-2 text-[11px] break-keep text-(--color-danger) ring-1 ring-(--color-danger)/30">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">{error}</span>
              </p>
            )}

            <div className="mt-3 flex items-center justify-end gap-2">
              <span className="mr-auto text-[10.5px] break-keep text-(--color-fg-4)">
                다시 돌려도 직접 고친 줄은 안 덮습니다
              </span>
              <button
                type="button"
                onClick={() => void run()}
                disabled={!canRun}
                className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-medium text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-50"
              >
                {starting && <Loader2 className="h-3 w-3 animate-spin" />}
                {starting ? "시작하는 중" : "다듬기 시작"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
