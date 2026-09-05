"use client";

import { AlertCircle, ArrowUpFromLine, AudioLines, Loader2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/client-api";
import type { ModelNoticeDTO, RecordingDTO, RecordingListResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CrossAppLink } from "./cross-app-link";
import { estimateTranscribe } from "./format";
import { isBusy } from "./job-state";
import { LanguageLine, ModelCredit } from "./language-notice";
import { RecordingCard } from "./recording-card";
import { UploadButton, UploadDrop } from "./upload-drop";
import { UploadPanel, useUploadSummary } from "./upload-panel";
import { enqueueUploads, setUploadSink } from "./upload-queue";

/**
 * 녹음 목록. 이 앱의 첫 화면.
 *
 * MemoBento 의 대시보드를 닮게 두되 카드를 누르면 **전사문**이 열린다.
 * 머리말 · 카드 격자 · 오른쪽 아래 전송 칸까지 자리를 그대로 맞췄다 — 네 앱을
 * 나란히 띄워 두고 쓰는 사람에게 다섯째만 배치가 다르면 그것만으로 낯설다.
 *
 * ## 첫 목록은 어디서 오나
 *
 * `initial` 을 받으면 그것으로 그리고, 없으면 붙자마자 받아 온다. 형제 앱들은
 * 서버 컴포넌트가 DB 를 읽어 넘기는데(그 편이 첫 화면이 안 깜빡인다), 이 앱은
 * 서버 읽기가 뼈대 담당 몫이라 아직 없을 수 있다. 그쪽이 준비되면
 * `page.tsx` 에서 한 줄로 끼워 넣으면 된다 — 여기는 안 고쳐도 된다.
 *
 * ## 다시 물어보는 때
 *
 * 도는 것이 하나라도 있을 때만 짧은 간격으로 물어본다. 전사는 60분짜리가
 * 6분쯤 걸리고 그동안 진행률이 화면에서 움직여야 한다. 다 끝나면 멈춘다 —
 * 아무것도 안 도는 목록이 2.5초마다 서버를 두드릴 이유가 없다. 탭이 안 보이면
 * 쉬고, 다시 보이는 순간 한 번 물어보므로 놓치지도 않는다.
 */

/** 도는 것이 있을 때 다시 물어보는 간격. */
const POLL_MS = 2500;

export function RecordingList({
  initial,
  mailbentoUrl,
  memobentoUrl,
  paperbentoUrl,
}: {
  initial?: RecordingListResponse | null;
  mailbentoUrl?: string | null;
  memobentoUrl?: string | null;
  paperbentoUrl?: string | null;
}) {
  const [recordings, setRecordings] = useState<RecordingDTO[]>(initial?.recordings ?? []);
  const [model, setModel] = useState<ModelNoticeDTO | null>(initial?.model ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const uploads = useUploadSummary();

  const fail = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : "요청에 실패했습니다");
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 6000);
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const j = await api.list(signal);
        setRecordings(j.recordings ?? []);
        if (j.model) setModel(j.model);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        fail(e);
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  // 처음 한 번. `initial` 을 받았어도 한 번 맞춰 본다 — 서버가 그린 뒤
  // 브라우저가 붙기까지 사이에 전사가 진행됐을 수 있다.
  useEffect(() => {
    const ctl = new AbortController();
    void refresh(ctl.signal);
    return () => ctl.abort();
  }, [refresh]);

  /*
   * 도는 것이 있으면 계속 물어본다.
   *
   * `busy` 를 의존성에 두었으므로 마지막 하나가 끝나는 순간 타이머가 걷힌다.
   * 새 파일을 올리면 그 녹음이 `queued` 로 들어와 다시 걸린다.
   */
  const busy = recordings.some((r) => isBusy(r.state));
  useEffect(() => {
    if (!busy) return;
    const ctl = new AbortController();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh(ctl.signal);
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      ctl.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [busy, refresh]);

  // 다 올라간 것이 곧바로 목록에 선다. 서버를 다시 부르지 않는다 —
  // 올리는 줄이 이미 녹음 한 건을 통째로 받아 왔다.
  useEffect(() => {
    setUploadSink((rec) => {
      setRecordings((prev) => (prev.some((r) => r.id === rec.id) ? prev : [rec, ...prev]));
    });
    return () => setUploadSink(null);
  }, []);

  // 올리기 시작하면 전송 칸을 연다. 큰 파일이라 진행이 보여야 한다.
  useEffect(() => {
    if (uploads.active > 0) setQueueOpen(true);
  }, [uploads.active]);

  const takeFiles = (files: File[]) => {
    enqueueUploads(files);
    setQueueOpen(true);
  };

  const onRename = async (id: string, title: string) => {
    try {
      const next = await api.rename(id, title);
      setRecordings((prev) => prev.map((r) => (r.id === id ? next : r)));
    } catch (e) {
      fail(e);
    }
  };

  const onDelete = async (id: string) => {
    // 눈에서 먼저 지운다. 서버가 거절하면 되돌린다 — 지우기는 거의 실패하지
    // 않는데, 그 드문 경우 때문에 흔한 경우가 한 박자 느려질 이유는 없다.
    const backup = recordings;
    setRecordings((prev) => prev.filter((r) => r.id !== id));
    try {
      await api.remove(id);
    } catch (e) {
      setRecordings(backup);
      fail(e);
    }
  };

  const onRetranscribe = async (id: string) => {
    try {
      await api.retranscribe(id);
      // 202 만 온다. 상태는 곧 폴링이 가져오지만, 누른 자리가 그대로면
      // 눌린 것 같지 않아 한 번 더 누르게 된다. 먼저 "차례 기다리는 중" 으로 둔다.
      setRecordings((prev) =>
        prev.map((r) => (r.id === id ? { ...r, state: "queued", progress: null, error: null } : r)),
      );
    } catch (e) {
      fail(e);
    }
  };

  return (
    <UploadDrop onFiles={takeFiles} onReject={(m) => fail(new Error(m))} bare>
      {/* 넓은 화면에서는 가로를 더 쓴다 — 형제 앱들과 같은 상한. */}
      <main className="relative mx-auto flex min-h-screen w-full max-w-[2560px] flex-col gap-6 px-6 py-10 lg:px-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-(--color-surface) ring-1 ring-(--color-border-soft)">
              <AudioLines className="h-5 w-5 text-(--color-accent)" />
            </div>
            <div>
              <h1 className="text-2xl leading-tight" style={{ fontFamily: "var(--font-serif)" }}>
                VoiceBento
              </h1>
              <p className="text-xs text-(--color-fg-4)">
                녹음 {recordings.length}
                {busy && " · 전사 도는 중"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQueueOpen((v) => !v)}
              aria-pressed={queueOpen}
              title="올리는 줄"
              className={cn(
                "relative flex items-center gap-2 rounded-full px-4 py-2 text-sm ring-1 transition",
                uploads.active > 0
                  ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40"
                  : "bg-(--color-surface) text-(--color-fg-2) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
              )}
            >
              <ArrowUpFromLine className={cn("h-4 w-4", uploads.active > 0 && "animate-pulse")} />
              <span className="hidden sm:inline">전송</span>
              {uploads.total > 0 && (
                <span className="rounded-full bg-(--color-bg-2) px-1.5 py-0.5 font-mono text-[10px] text-(--color-fg-3)">
                  {uploads.active > 0 ? uploads.active : uploads.total}
                </span>
              )}
            </button>
            <CrossAppLink app="mailbento" href={mailbentoUrl} />
            <CrossAppLink app="memobento" href={memobentoUrl} />
            <CrossAppLink app="paperbento" href={paperbentoUrl} />
          </div>
        </header>

        {/*
          올리는 자리. **목록 위에 둔다** — 이 앱에서 가장 자주 하는 일이
          파일을 올리는 것이고, 카드가 스무 장 쌓인 뒤에도 그 자리는 안 밀려야 한다.
          한국어 안내도 여기 붙는다. 올리기 전에 보여야 뜻이 있다.
        */}
        <section className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-(--color-surface) p-5 ring-1 ring-(--color-border-soft)">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Upload className="h-4 w-4 shrink-0 text-(--color-accent)" />
              <div className="min-w-0">
                <p className="text-sm text-(--color-fg-2)">
                  소리나 영상 파일을 끌어다 놓거나 골라서 올리세요
                </p>
                <p className="text-[11px] break-keep text-(--color-fg-4)">
                  영상은 소리만 뽑아서 씁니다. 전사에는 오디오 길이의 약 1/10 이 걸립니다 (1시간 →{" "}
                  {estimateTranscribe(3600)}).
                </p>
              </div>
            </div>
            <UploadButton onFiles={takeFiles} onReject={(m) => fail(new Error(m))} />
          </div>
          <LanguageLine model={model} />
        </section>

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-(--color-fg-4)">
            <Loader2 className="h-4 w-4 animate-spin" />
            녹음을 불러오는 중…
          </p>
        ) : recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-(--color-border) py-20 text-center">
            <AudioLines className="h-7 w-7 text-(--color-fg-4)" />
            <p className="text-sm text-(--color-fg-3)">아직 올린 녹음이 없습니다</p>
            <p className="max-w-[34rem] px-6 text-[12px] leading-relaxed break-keep text-(--color-fg-4)">
              회의 녹음, 인터뷰, 강의 영상을 올리면 글로 옮겨 드립니다. 옮긴 글은 시각을 눌러
              그 대목을 들을 수 있고, 손으로 고칠 수도 있습니다.
            </p>
          </div>
        ) : (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {recordings.map((r) => (
              <RecordingCard
                key={r.id}
                recording={r}
                onRename={onRename}
                onDelete={onDelete}
                onRetranscribe={onRetranscribe}
              />
            ))}
          </section>
        )}

        {/* 모델 출처. CC-BY-4.0 이라 화면에도 남겨야 한다. */}
        <footer className="mt-auto pt-4">
          <ModelCredit model={model} />
        </footer>

        {error && (
          <div className="fixed bottom-6 left-6 z-50 flex max-w-[min(28rem,90vw)] items-start gap-2 rounded-lg bg-(--color-danger)/15 px-4 py-2.5 text-xs break-keep text-(--color-danger) shadow-lg ring-1 ring-(--color-danger)/30">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="닫기"
              className="shrink-0 rounded p-0.5 transition hover:bg-(--color-danger)/20"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <UploadPanel open={queueOpen} onClose={() => setQueueOpen(false)} />
      </main>
    </UploadDrop>
  );
}
