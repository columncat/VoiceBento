"use client";

import { AlertTriangle, Layers, Loader2, Users, WandSparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { JobState, SegmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { formatBytes } from "./format";

/**
 * 다듬기 — 전사문을 에이전트에게 통째로 넘겨 **문장을** 고르게 하는 자리.
 *
 * ## 화자는 이제 여기서 안 정한다
 *
 * 예전에는 이 자리가 화자까지 정했다. 소리를 안 듣고 대사의 흐름만 보고
 * 추정하는 길이었다. 지금은 **소리로 가른다** — 목소리를 재서 무리를 짓고,
 * 그 무리에 이름을 다는 것만 사람과 에이전트가 한다 (위 “화자” 패널).
 *
 * 다듬기 응답에서 줄마다 화자를 받던 문은 **아예 없앴다.** 남겨 두면 근거가
 * 다른 두 이름이 한 화면에서 뒤섞이는데, 어느 줄이 어느 근거에서 나온
 * 것인지는 아무 데도 안 보인다.
 *
 * ## 그래도 통째로 넘긴다
 *
 * 문장을 고르는 데도 앞뒤가 필요하다. 조각을 나눠 보내면 경계마다 맥락이
 * 끊겨 같은 용어가 줄마다 다른 철자로 남는다.
 *
 * ## 안 들어가면 **조용히 자르지 않는다**
 *
 * 에이전트 입구가 한 번에 받는 것은 512KB 다. 한 시간짜리 전사문은 글자로
 * 수만 자라 대개 그 안쪽이지만, 넘는 녹음이 언젠가 나온다. 그때 앞부분만
 * 잘라 보내면 **뒤쪽 절반이 다듬어지지 않은 채 남고** 사람은 그 사실을
 * 모른다 — 게다가 에이전트는 못 본 대목을 "없다" 고 답한다. 그래서 넘치면
 * 아예 시작하지 않고, 얼마나 넘쳤는지를 숫자로 적는다.
 *
 * 크기는 **여기서 미리 재서 보여 준다.** 서버도 같은 것을 봐야 하지만,
 * 눌러 보고 나서 "안 됩니다" 를 듣는 것보다 누르기 전에 아는 편이 낫다.
 *
 * ## 세션 하나에서 돈다
 *
 * 다듬기·대화·요약이 **같은 세션**을 쓴다. 전에는 다듬기가 일회용이라 방금
 * 다듬으며 정한 용어와 말투를 대화창이 몰랐다. 같은 세션에서 돌면 대화가
 * 그것을 이어받는다.
 *
 * 그 대신 **한 세션에서 둘이 동시에 돌 수 없다.** 같은 세션에 `--resume` 이
 * 겹치면 대화가 서로를 덮어쓴다. 서버가 줄을 세우고, 화면은 기다린다는 것을
 * 그대로 적는다 (`queuedBehind`).
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
  sessionName,
  onRun,
  className,
}: {
  recordingId: string;
  segments: SegmentDTO[];
  state: JobState;
  /** 어느 세션에서 도는지. 안 붙어 있으면 null. */
  sessionName: string | null;
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
              ? "에이전트가 문장을 다듬습니다. 화자는 안 건드립니다 — 그건 위 “화자” 의 일입니다"
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
        {polishing ? "다듬는 중" : "문장 다듬기"}
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

            {/*
              어느 세션에서 도는지 먼저 말한다. 맥락을 적기 전에 알아야 할
              것이다 — 세션이 이미 지난 회차의 용어를 들고 있으면 여기에
              같은 것을 또 적을 필요가 없다.
            */}
            <p className="mb-2 flex items-start gap-1.5 rounded-md bg-(--color-bg-2) px-2.5 py-1.5 text-[11px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)">
              <Layers className="mt-0.5 h-3 w-3 shrink-0 text-(--color-accent-strong)" />
              <span className="min-w-0">
                {sessionName ? (
                  <>
                    세션 <b className="font-medium text-(--color-fg-2)">{sessionName}</b> 에서
                    돕니다. 이 세션의 지난 녹음에서 쓰던 용어와 말투를 이어받고, 다듬은 결과는
                    오른쪽 대화창이 그대로 이어받습니다.
                  </>
                ) : (
                  <>
                    이 녹음은 어느 세션에도 붙어 있지 않습니다. 이어받을 지난 회차가 없고, 다듬은
                    결과도 이 녹음 안에서만 남습니다.
                  </>
                )}
              </span>
            </p>

            <p className="mb-2 text-[11px] leading-relaxed break-keep text-(--color-fg-4)">
              {/*
                맥락 한 줄이 결과를 크게 바꾼다. 분야를 알면 전문 용어의
                철자가 맞고, 무슨 자리인지 알면 말투가 어울리게 다듬어진다.
                비워도 되지만 왜 적으면 좋은지는 말해 준다 — 안 그러면
                아무도 안 적는다.

                **화자 이야기는 여기서 뺐다.** 이제 화자는 소리로 가른다.
                여기 사람 이름을 적어도 줄에 안 붙는다 — 그 자리는 위
                "화자" 패널이다. 이 칸이 그런 약속을 하면 안 된다.
              */}
              무슨 자리인지, 무엇에 대한 이야기인지 알면 용어 교정이 크게 좋아집니다. 비워 두어도
              됩니다. 말한 사람 목록은 여기가 아니라 위 “화자” 에 적습니다.
            </p>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              disabled={starting || polishing}
              rows={3}
              placeholder="예) 3월 14일 제품팀 주간 회의. 배포 일정과 결제 모듈 이야기."
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
                넘쳤다. **자르지 않는다** — 앞부분만 보내면 뒤쪽 절반이
                다듬어지지 않은 채 남고 사람은 그 사실을 모른다. 대신 무엇을
                할 수 있는지를 적는다.
              */
              <p className="mt-3 flex items-start gap-1.5 rounded-md bg-(--color-danger)/10 px-3 py-2 text-[11px] leading-relaxed break-keep text-(--color-danger) ring-1 ring-(--color-danger)/30">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">
                  전사문이 에이전트가 한 번에 받는 크기(512KB)를 {formatBytes(bytes - AGENT_LIMIT)}{" "}
                  넘습니다. <b className="font-medium">앞부분만 잘라 보내지 않습니다</b> — 그러면
                  뒷부분이 다듬어지지 않은 채 남고, 그 사실이 화면에 드러나지 않습니다. 녹음을
                  나눠 올린 뒤 각각 다듬어 주세요.
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
                {sessionName && " · 같은 세션의 다른 녹음이 돌고 있으면 차례를 기다립니다"}
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
