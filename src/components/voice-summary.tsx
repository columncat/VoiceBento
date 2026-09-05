"use client";

import { AlertTriangle, Eye, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { RichText } from "@/components/rich-text";
import { api } from "@/lib/client-api";
import { DEFAULT_SUMMARY_PROMPT, type JobState, type SummaryDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 요약. 오른쪽 날개의 **아래쪽** — 대화 바로 밑이다.
 *
 * 대화가 위인 이유는 PaperBento 와 같다. 묻는 것이 먼저이고 요약은 그 결과를
 * 적어 두는 자리다. 아래에 두면 대화가 길어졌을 때 요약이 화면 밖으로 밀려
 * 나가 있는 줄도 모르게 된다.
 *
 * ## 실행은 언제나 사람이 누른다
 *
 * 상자를 여는 것도 지시문을 손보는 것도 아직 아무 일도 일으키지 않는다.
 * 서버로 무언가 가는 것은 "실행" 을 누른 그 순간뿐이다. 전사가 끝날 때
 * 자동으로 요약까지 돌리는 길은 만들지 않았다 — 요약은 에이전트 한 번을
 * 부르는 일이고, 안 볼 요약을 녹음마다 만들 이유가 없다.
 *
 * ## 사람이 쓴 요약은 확인받고 덮는다
 *
 * 에이전트가 만든 요약을 다시 만드는 것은 잃을 것이 없다. 사람이 손으로 적은
 * 글은 다시 만들 수 없다. 그래서 그때만 확인 단계를 하나 세운다. 서버도 같은
 * 것을 봐야 한다 — 화면만 믿지 않는다.
 */

/** 물어보는 간격. 더 짧게 해도 답이 빨리 나오지 않는다. */
const POLL_MS = 2500;

export function VoiceSummary({
  recordingId,
  state,
  className,
}: {
  recordingId: string;
  /** 전사가 끝났는가. 안 끝났으면 요약할 글이 없다. */
  state: JobState;
  className?: string;
}) {
  const [summary, setSummary] = useState<SummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [instruction, setInstruction] = useState(DEFAULT_SUMMARY_PROMPT);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** 화면이 사라진 뒤 늦게 온 답이 상태를 건드리지 않게. */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, []);

  useEffect(() => {
    let on = true;
    api
      .summary(recordingId)
      .then((j) => {
        if (!on) return;
        setSummary(j.summary);
      })
      .catch((e: unknown) => {
        if (!on) return;
        setError(e instanceof Error ? e.message : "요약을 불러오지 못했습니다");
      })
      .finally(() => {
        if (on) setLoading(false);
      });
    return () => {
      on = false;
    };
  }, [recordingId]);

  const finish = useCallback((next: SummaryDTO | null) => {
    setRunning(false);
    setSummary(next);
    setPanelOpen(false);
    setConfirmed(false);
  }, []);

  /** 몇 초마다 물어본다. 요약은 1분을 넘기는 일이 흔하다. */
  const poll = useCallback(
    (runId: string, startedAt: number) => {
      const tick = async () => {
        if (!alive.current) return;
        try {
          const j = await api.summaryStatus(recordingId, runId);
          if (!alive.current) return;
          if (!j.run || j.run.state === "running") {
            setElapsed(Math.round((Date.now() - startedAt) / 1000));
            timers.current.push(setTimeout(() => void tick(), POLL_MS));
            return;
          }
          if (j.run.state === "failed") {
            setRunning(false);
            setError(j.run.error ?? "요약을 만들지 못했습니다");
            return;
          }
          finish(j.summary);
        } catch (e) {
          if (!alive.current) return;
          setRunning(false);
          setError(e instanceof Error ? e.message : "요약을 만들지 못했습니다");
        }
      };
      timers.current.push(setTimeout(() => void tick(), POLL_MS));
    },
    [recordingId, finish],
  );

  const humanWritten = summary?.source === "human" && summary.body.trim().length > 0;
  const canRun = instruction.trim().length > 0 && (!humanWritten || confirmed) && !running;

  const run = async () => {
    setError(null);
    setRunning(true);
    setElapsed(0);
    const startedAt = Date.now();
    try {
      const j = await api.startSummary(recordingId, instruction, humanWritten);
      if (!alive.current) return;
      // 시작하자마자 끝난 경우를 위해 상태를 먼저 본다.
      if (j.run?.state === "done") {
        finish(j.summary);
        return;
      }
      if (!j.run || j.run.state === "failed") {
        setRunning(false);
        setError(j.run?.error ?? "요약을 시작하지 못했습니다");
        return;
      }
      poll(j.run.id, startedAt);
    } catch (e) {
      if (!alive.current) return;
      setRunning(false);
      setError(e instanceof Error ? e.message : "요약을 시작하지 못했습니다");
    }
  };

  const saveMine = async () => {
    setSaving(true);
    setError(null);
    try {
      const j = await api.saveSummary(recordingId, draft);
      setSummary(j.summary);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "요약을 저장하지 못했습니다");
    } finally {
      setSaving(false);
    }
  };

  const ready = state === "done" || state === "polishing";

  return (
    <section
      className={cn(
        "flex min-h-[220px] flex-col rounded-[var(--radius-card)] bg-(--color-surface) p-6 ring-1 ring-(--color-border-soft)",
        className,
      )}
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="shrink-0 text-base font-medium text-(--color-fg)">요약</h2>
          {summary?.source === "agent" && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-(--color-accent-soft) px-1.5 py-0.5 text-[10px] text-(--color-accent-strong)"
              title={summary.instruction ?? "에이전트가 만든 요약"}
            >
              <Sparkles className="h-2.5 w-2.5" />
              에이전트
            </span>
          )}
        </div>

        <div className="relative flex shrink-0 items-center gap-1.5">
          {/*
            단추는 늘 제자리에 있고, 상자는 그 위에 **띄워서** 그린다.
            열 때 단추를 상자로 갈아 끼우면 요약 칸이 통째로 커졌다가 닫으면
            줄어들어, 읽던 요약이 아래로 밀려났다 돌아온다.
          */}
          <button
            type="button"
            onClick={() => {
              setPanelOpen((v) => !v);
              setError(null);
            }}
            disabled={!ready}
            aria-expanded={panelOpen}
            title={
              ready
                ? "전사문을 넘겨 요약을 만듭니다"
                : "전사가 끝나야 요약할 글이 생깁니다"
            }
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] ring-1 transition disabled:opacity-40",
              panelOpen
                ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40"
                : "bg-(--color-bg-2) text-(--color-fg-2) ring-(--color-border-soft) hover:bg-(--color-surface-hi)",
            )}
          >
            <Sparkles className="h-3 w-3" />
            에이전트에게 맡기기
          </button>

          <button
            type="button"
            onClick={() => {
              setDraft(summary?.body ?? "");
              setEditing((v) => !v);
            }}
            className="flex items-center gap-1.5 rounded-full bg-(--color-bg-2) px-3 py-1.5 text-[11px] text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
          >
            {editing ? <Eye className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
            {editing ? "보기" : "고치기"}
          </button>

          {panelOpen && (
            <>
              {/* 바깥을 눌러 닫는 자리. 실행 전이므로 닫아도 잃을 것이 없다. */}
              <div className="fixed inset-0 z-20" onClick={() => setPanelOpen(false)} aria-hidden />
              <div className="absolute top-full right-0 z-30 mt-2 w-[min(30rem,calc(100vw-3rem))] rounded-lg bg-(--color-surface-2) p-4 shadow-lg ring-1 ring-(--color-border-soft)">
                <header className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-(--color-fg-2)">
                    <Sparkles className="h-3.5 w-3.5 text-(--color-accent-strong)" />
                    무엇을 시킬지 적으세요
                  </span>
                  <button
                    type="button"
                    onClick={() => setPanelOpen(false)}
                    disabled={running}
                    aria-label="닫기"
                    className="rounded-full p-1 text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2) disabled:opacity-40"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </header>

                {/*
                  지시문을 접어 두지 않고 그대로 펼쳐 둔다. 요약이 마음에 안
                  들었을 때 "왜 이렇게 나왔지" 를 되짚으려면, 그때 무엇을
                  시켰는지가 눈에 보이는 자리에 있어야 한다.
                */}
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  disabled={running}
                  rows={7}
                  className="scrollbar-thin w-full resize-y rounded-md bg-(--color-surface) p-2.5 text-[11.5px] leading-relaxed text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
                  aria-label="요약 지시문"
                />

                {humanWritten && (
                  <label className="mt-3 flex items-start gap-2 rounded-md bg-(--color-surface) px-3 py-2.5 text-[11px] ring-1 ring-(--color-border-soft)">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      disabled={running}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    />
                    <span className="min-w-0 break-keep text-(--color-fg-3)">
                      <b className="text-(--color-fg-2)">직접 쓰신 요약이 이미 있습니다.</b> 새로
                      만들면 지금 글은 사라지고 되돌릴 수 없습니다. 덮어써도 괜찮습니다.
                    </span>
                  </label>
                )}

                <div className="mt-3 flex items-center justify-end gap-2">
                  <span className="mr-auto text-[10.5px] break-keep text-(--color-fg-4)">
                    {running ? `읽고 쓰는 중… ${elapsed}초` : "전사문 전체가 에이전트에게 넘어갑니다"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void run()}
                    disabled={!canRun}
                    className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-medium text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-50"
                  >
                    {running && <Loader2 className="h-3 w-3 animate-spin" />}
                    {running ? "만드는 중" : "실행"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      {error && (
        <p className="mb-3 flex items-start gap-1.5 rounded-md bg-(--color-danger)/10 px-3 py-2 text-[11px] break-keep text-(--color-danger) ring-1 ring-(--color-danger)/30">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            placeholder="이 녹음이 무엇이었는지 적어 두세요. 마크다운을 씁니다."
            className="scrollbar-thin min-h-[160px] w-full flex-1 resize-y rounded-lg bg-(--color-bg-2) p-3 text-[13px] leading-relaxed text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
            aria-label="요약"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded-full bg-(--color-bg-2) px-3 py-1.5 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void saveMine()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-1.5 text-[11px] font-medium text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              저장
            </button>
          </div>
        </div>
      ) : loading ? (
        <p className="flex items-center gap-2 py-6 text-[12px] text-(--color-fg-4)">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          요약을 불러오는 중…
        </p>
      ) : summary?.body.trim() ? (
        <RichText
          text={summary.body}
          className="text-[13px] leading-relaxed break-keep text-(--color-fg-2)"
        />
      ) : (
        <p className="py-6 text-center text-[12px] break-keep text-(--color-fg-4)">
          {ready
            ? "아직 요약이 없습니다. 에이전트에게 맡기거나 직접 적을 수 있습니다."
            : "전사가 끝나면 요약할 수 있습니다."}
        </p>
      )}
    </section>
  );
}
