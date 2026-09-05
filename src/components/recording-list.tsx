"use client";

import {
  AlertCircle,
  ArrowUpFromLine,
  AudioLines,
  Clock3,
  Layers,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/client-api";
import type {
  ModelNoticeDTO,
  RecordingListResponse,
  RecordingWithSession,
  SessionDTO,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { CrossAppLink } from "./cross-app-link";
import { estimateTranscribe } from "./format";
import { isBusy } from "./job-state";
import { LanguageLine, ModelCredit } from "./language-notice";
import { readModel } from "./model-capability";
import { RecordingCard } from "./recording-card";
import { SessionHeader } from "./session-header";
import { SessionPicker, type UploadTarget } from "./session-picker";
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
 * ## 세션이 이 화면의 뼈대가 되었다
 *
 * 전에는 녹음 하나가 곧 세션이었다. 이제 세션이 따로 있고 녹음 여럿이 붙는다.
 * 그래서 목록도 **세션별로 묶어** 보여 준다 — 주간 회의 다섯 회차가 시간순
 * 카드 스무 장 사이에 흩어져 있으면, 그 다섯이 한 덩어리라는 사실이 화면에
 * 아무 데도 없다.
 *
 * 묶기만 하면 "언제 올린 것" 으로 훑는 길이 막힌다. 그래서 **묶어 보기 /
 * 시간순** 을 고를 수 있게 하고 고른 것을 기억한다. 세션이 스무 개가 되면
 * 시간순이 더 나은 날이 온다.
 *
 * ## 첫 목록은 어디서 오나
 *
 * `initial` 을 받으면 그것으로 그리고, 없으면 붙자마자 받아 온다. 첫 화면이
 * 안 깜빡이게 하려는 것이다. 붙자마자 한 번 더 물어보므로(그 사이에 전사가
 * 진행됐을 수 있다) 이 값이 조금 낡아도 된다.
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

/**
 * 묶어 볼지 시간순으로 볼지 기억할 자리.
 *
 * `voicebento.` 접두어를 붙인다. 한 도메인에 `/voice` 와 `/memo` 와 `/paper` 를
 * 나란히 얹으면 오리진이 같아지고, localStorage 는 경로를 구분하지 않는다.
 */
const GROUPING_KEY = "voicebento.listGrouping";

interface Group {
  /** null 이면 "세션 없음" 묶음. */
  session: SessionDTO | null;
  recordings: RecordingWithSession[];
}

export function RecordingList({
  initial,
  mailbentoUrl,
  memobentoUrl,
  paperbentoUrl,
}: {
  /**
   * 서버가 그린 첫 목록.
   *
   * 세션은 아직 안 실려 올 수 있다(`page.tsx` 참고). 그래서 이 칸을 부분
   * 모양으로 받는다 — 있으면 쓰고 없으면 붙자마자 받아 온다.
   */
  initial?: Partial<RecordingListResponse> | null;
  mailbentoUrl?: string | null;
  memobentoUrl?: string | null;
  paperbentoUrl?: string | null;
}) {
  const [recordings, setRecordings] = useState<RecordingWithSession[]>(initial?.recordings ?? []);
  const [sessions, setSessions] = useState<SessionDTO[]>(initial?.sessions ?? []);
  const [model, setModel] = useState<ModelNoticeDTO | null>(initial?.model ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [grouped, setGrouped] = useState(true);
  /** 어디로 보낼지 아직 안 정한 파일들. 정해지기 전에는 전송이 시작되지 않는다. */
  const [pending, setPending] = useState<File[] | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 목록 응답이 세션까지 실어 주는가.
   *
   * 실어 주면 폴링이 세션 수까지 함께 갱신하므로 따로 부를 일이 없다.
   * 안 실어 주면(서버가 아직 안 붙였거나 계약이 다르면) 세션만 따로 받아 온다 —
   * 그 경우에도 카드가 사라지지 않게, 세션을 못 찾은 녹음은 아래에서
   * "세션 없음" 묶음으로 간다.
   */
  const sessionsInList = useRef(Array.isArray(initial?.sessions));

  const uploads = useUploadSummary();
  const cap = useMemo(() => readModel(model), [model]);

  const fail = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : "요청에 실패했습니다");
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 6000);
  }, []);

  /** 세션만 따로. 라우트가 아직 없으면 조용히 넘어간다 — 목록은 그대로 산다. */
  const loadSessions = useCallback(async (signal?: AbortSignal) => {
    try {
      setSessions(await api.sessions.list(signal));
    } catch {
      /* 세션을 못 받아도 녹음은 보여야 한다 */
    }
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const j = await api.list(signal);
        setRecordings(j.recordings ?? []);
        if (j.model) setModel(j.model);
        if (Array.isArray(j.sessions)) {
          setSessions(j.sessions);
          sessionsInList.current = true;
        } else if (!sessionsInList.current) {
          void loadSessions(signal);
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        fail(e);
      } finally {
        setLoading(false);
      }
    },
    [fail, loadSessions],
  );

  // 기억해 둔 값은 **붙은 뒤에** 읽는다. 그릴 때 읽으면 서버가 그린 것과
  // 달라져 하이드레이션이 어긋난다 — localStorage 는 서버에 없다.
  useEffect(() => {
    try {
      const v = localStorage.getItem(GROUPING_KEY);
      if (v !== null) setGrouped(v !== "time");
    } catch {
      /* 사생활 보호 모드 등 — 기본값(묶어 보기)으로 산다 */
    }
  }, []);

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
  // 올리는 줄이 이미 녹음 한 건을 통째로 받아 왔다. 세션의 녹음 수만
  // 어긋나므로 그것만 따로 맞춘다.
  useEffect(() => {
    setUploadSink((rec) => {
      setRecordings((prev) => (prev.some((r) => r.id === rec.id) ? prev : [rec, ...prev]));
      if (!sessionsInList.current) void loadSessions();
    });
    return () => setUploadSink(null);
  }, [loadSessions]);

  // 올리기 시작하면 전송 칸을 연다. 큰 파일이라 진행이 보여야 한다.
  useEffect(() => {
    if (uploads.active > 0) setQueueOpen(true);
  }, [uploads.active]);

  /**
   * 파일을 받았다. **아직 올리지 않는다.**
   *
   * 어디로 보낼지 정해지기 전에 전송을 시작하면, 올라가자마자 전사가 돌고
   * 전사가 끝나면 다듬기가 돈다 — 그때 세션이 안 정해져 있으면 첫 다듬기가
   * 이미 엉뚱한 자리에서 돈 뒤다. 그래서 여기서 한 번 멈춘다.
   *
   * 고르는 동안 파일을 더 놓으면 뒤에 붙인다. 놓을 때마다 물음이 새로
   * 시작되면 먼저 적던 세션 이름이 날아간다.
   */
  const takeFiles = (files: File[]) => {
    setPending((prev) => (prev ? [...prev, ...files] : files));
  };

  /** 목적지가 이미 정해진 자리(세션 머리말)에서 온 파일. 묻지 않는다. */
  const uploadInto = (files: File[], sessionId: string, sessionName: string | null) => {
    enqueueUploads(files, sessionId, sessionName);
    setQueueOpen(true);
  };

  const confirmTarget = async (target: UploadTarget) => {
    const files = pending;
    if (!files || files.length === 0) {
      setPending(null);
      return;
    }
    try {
      /*
       * 새 세션이면 **여기서 먼저 만든다.**
       *
       * 이름만 들려 보내고 서버가 알아서 만들게 하면, 파일 넷이 각각
       * `finish` 를 부르면서 같은 이름의 세션이 넷 생긴다. 먼저 만들어 id 를
       * 받으면 넷이 한 자리로 간다. 값은 하나 — 전송이 다 실패하면 빈 세션이
       * 남는다. 빈 세션은 목록에 "녹음 0" 으로 그대로 보이고 지울 수 있다.
       */
      const id =
        target.kind === "existing" ? target.id : (await api.sessions.create(target.name)).id;
      const name =
        target.kind === "existing"
          ? (sessions.find((s) => s.id === target.id)?.name ?? null)
          : target.name;

      setPending(null);
      enqueueUploads(files, id, name);
      setQueueOpen(true);
      void loadSessions();
    } catch (e) {
      // 세션을 못 만들었다. 파일은 그대로 들고 있는다 — 여기서 버리면
      // 사람이 파일을 다시 골라야 한다.
      fail(e);
    }
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
      void loadSessions();
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

  const onRenameSession = async (id: string, name: string) => {
    try {
      const next = await api.sessions.rename(id, name);
      setSessions((prev) => prev.map((s) => (s.id === id ? next : s)));
    } catch (e) {
      fail(e);
    }
  };

  const onDeleteSession = async (id: string) => {
    const backupSessions = sessions;
    const backupRecordings = recordings;
    /*
     * 세션만 지운다. **녹음은 눈앞에서 사라지면 안 된다** — 지우는 순간 카드
     * 다섯 장이 함께 없어지면, 확인 문구에 "전사문은 남습니다" 라고 적어 둔
     * 것이 거짓말처럼 보인다. 자리만 "세션 없음" 으로 옮긴다.
     */
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setRecordings((prev) => prev.map((r) => (r.sessionId === id ? { ...r, sessionId: null } : r)));
    try {
      await api.sessions.remove(id);
    } catch (e) {
      setSessions(backupSessions);
      setRecordings(backupRecordings);
      fail(e);
    }
  };

  const rememberGrouping = (on: boolean) => {
    setGrouped(on);
    try {
      localStorage.setItem(GROUPING_KEY, on ? "session" : "time");
    } catch {
      /* 못 적어도 이번 화면에서는 잘 돌아간다 */
    }
  };

  /** 이름을 찾기 위한 표. 시간순 보기의 카드가 세션 이름을 다는 데 쓴다. */
  const sessionName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) m.set(s.id, s.name);
    return m;
  }, [sessions]);

  /**
   * 세션별 묶음.
   *
   * 세션을 먼저 훑고, **남은 것을 전부 "세션 없음" 으로** 보낸다. 세션 목록을
   * 못 받았거나 지워진 세션을 가리키는 녹음이 있어도 카드가 사라지지 않게
   * 하려는 것이다 — 목록에서 카드 한 장이 조용히 없어지는 것이 이 화면에서
   * 가장 나쁜 고장이다.
   */
  const groups = useMemo<Group[]>(() => {
    const byId = new Map<string, RecordingWithSession[]>();
    for (const r of recordings) {
      const sid = r.sessionId;
      if (!sid) continue;
      const bucket = byId.get(sid);
      if (bucket) bucket.push(r);
      else byId.set(sid, [r]);
    }

    const ordered = [...sessions].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    const out: Group[] = ordered.map((s) => ({
      session: s,
      recordings: byId.get(s.id) ?? [],
    }));

    const claimed = new Set(ordered.map((s) => s.id));
    const rest = recordings.filter((r) => !r.sessionId || !claimed.has(r.sessionId));
    if (rest.length > 0) out.push({ session: null, recordings: rest });

    return out;
  }, [recordings, sessions]);

  const showGroups = grouped && (sessions.length > 0 || groups.length > 1);

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
                {sessions.length > 0 && ` · 세션 ${sessions.length}`}
                {busy && " · 전사 도는 중"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {sessions.length > 0 && (
              /*
                묶어 보기 / 시간순.

                세션이 하나도 없으면 고를 것이 없으므로 아예 안 그린다. 켜짐을
                색으로만 가르지 않는다 — 아이콘과 글자가 함께 바뀌고 낭독기에는
                `aria-pressed` 로 간다.
              */
              <div
                className="flex items-center gap-0.5 rounded-full bg-(--color-surface) p-0.5 ring-1 ring-(--color-border-soft)"
                role="group"
                aria-label="목록 묶는 법"
              >
                <button
                  type="button"
                  onClick={() => rememberGrouping(true)}
                  aria-pressed={grouped}
                  title="세션별로 묶어 봅니다"
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition",
                    grouped
                      ? "bg-(--color-accent-soft) text-(--color-accent-strong)"
                      : "text-(--color-fg-3) hover:bg-(--color-surface-2)",
                  )}
                >
                  <Layers className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">세션별</span>
                </button>
                <button
                  type="button"
                  onClick={() => rememberGrouping(false)}
                  aria-pressed={!grouped}
                  title="올린 순서대로 봅니다"
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition",
                    !grouped
                      ? "bg-(--color-accent-soft) text-(--color-accent-strong)"
                      : "text-(--color-fg-3) hover:bg-(--color-surface-2)",
                  )}
                >
                  <Clock3 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">시간순</span>
                </button>
              </div>
            )}

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
          모델 안내도 여기 붙는다. 올리기 전에 보여야 뜻이 있다.

          파일을 받으면 이 자리가 통째로 **어디로 보낼지 묻는 화면**으로 바뀐다.
          둘을 같이 두면 "올리기" 가 두 군데가 되어, 물음에 답하지 않고 다시
          파일을 고르는 길이 생긴다.
        */}
        {pending ? (
          <SessionPicker
            files={pending}
            sessions={sessions}
            // 올리기 직전이 이 안내가 가장 필요한 순간이다. 상자와 함께 사라지면 안 된다.
            notice={<LanguageLine cap={cap} />}
            onCancel={() => setPending(null)}
            onConfirm={(t) => void confirmTarget(t)}
          />
        ) : (
          <section className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-(--color-surface) p-5 ring-1 ring-(--color-border-soft)">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Upload className="h-4 w-4 shrink-0 text-(--color-accent)" />
                <div className="min-w-0">
                  <p className="text-sm text-(--color-fg-2)">
                    소리나 영상 파일을 끌어다 놓거나 골라서 올리세요
                  </p>
                  <p className="text-[11px] break-keep text-(--color-fg-4)">
                    영상은 소리만 뽑아서 씁니다.{" "}
                    {cap.rtf !== null && (
                      <>
                        전사에는 오디오 길이의 약{" "}
                        {Math.max(1, Math.round(cap.rtf * 100))}% 가 걸립니다 (1시간 →{" "}
                        {estimateTranscribe(3600, cap.rtf)}).{" "}
                      </>
                    )}
                    올릴 때 어느 세션에 넣을지 한 번 묻습니다.
                  </p>
                </div>
              </div>
              <UploadButton onFiles={takeFiles} onReject={(m) => fail(new Error(m))} />
            </div>
            <LanguageLine cap={cap} />
          </section>
        )}

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-(--color-fg-4)">
            <Loader2 className="h-4 w-4 animate-spin" />
            녹음을 불러오는 중…
          </p>
        ) : recordings.length === 0 && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-(--color-border) py-20 text-center">
            <AudioLines className="h-7 w-7 text-(--color-fg-4)" />
            <p className="text-sm text-(--color-fg-3)">아직 올린 녹음이 없습니다</p>
            <p className="max-w-[34rem] px-6 text-[12px] leading-relaxed break-keep text-(--color-fg-4)">
              회의 녹음, 인터뷰, 강의 영상을 올리면 글로 옮겨 드립니다. 옮긴 글은 시각을 눌러
              그 대목을 들을 수 있고, 손으로 고칠 수도 있습니다. 같은 회의가 반복되면 한 세션에
              모아 두세요 — 지난 회차의 화자 이름과 용어를 물려받습니다.
            </p>
          </div>
        ) : showGroups ? (
          <div className="flex flex-col gap-7">
            {groups.map((g) => (
              <section key={g.session?.id ?? "__none__"} className="flex flex-col gap-3">
                <SessionHeader
                  session={g.session}
                  count={g.recordings.length}
                  onRename={onRenameSession}
                  onDelete={onDeleteSession}
                  onUploadHere={(files, id) =>
                    uploadInto(files, id, sessionName.get(id) ?? null)
                  }
                  onReject={(m) => fail(new Error(m))}
                />

                {g.recordings.length === 0 ? (
                  /*
                    빈 세션. 만들어 두고 아직 안 올렸거나, 올리다 실패한
                    자리다. 감추지 않는다 — 안 보이면 지울 수도 없고, 다음에
                    고르는 목록에는 계속 나타난다.
                  */
                  <p className="px-1 text-[11.5px] break-keep text-(--color-fg-4)">
                    아직 이 세션에 붙은 녹음이 없습니다. 위의 “이 세션에 올리기” 로 넣으세요.
                  </p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {g.recordings.map((r) => (
                      <RecordingCard
                        key={r.id}
                        recording={r}
                        rtf={cap.rtf}
                        onRename={onRename}
                        onDelete={onDelete}
                        onRetranscribe={onRetranscribe}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        ) : (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {recordings.map((r) => (
              <RecordingCard
                key={r.id}
                recording={r}
                rtf={cap.rtf}
                // 시간순으로 볼 때는 카드가 스스로 어느 세션인지 말해야 한다.
                sessionName={r.sessionName ?? (r.sessionId ? (sessionName.get(r.sessionId) ?? null) : null)}
                onRename={onRename}
                onDelete={onDelete}
                onRetranscribe={onRetranscribe}
              />
            ))}
          </section>
        )}

        {/* 모델 출처. CC-BY-4.0 이라 화면에도 남겨야 한다. */}
        <footer className="mt-auto pt-4">
          <ModelCredit cap={cap} />
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
