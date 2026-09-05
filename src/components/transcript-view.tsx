"use client";

import {
  AlertCircle,
  ArrowLeft,
  Clock,
  ListRestart,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, audioUrl } from "@/lib/client-api";
import type {
  ModelNoticeDTO,
  RecordingNoticeDTO,
  RecordingWithSession,
  SegmentDTO,
  SessionDTO,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { AudioBar } from "./audio-bar";
import { CrossAppLink } from "./cross-app-link";
import { formatLength } from "./format";
import { JobProgress, StateBadge, isBusy } from "./job-state";
import { readModel } from "./model-capability";
import { PolishPanel } from "./polish-panel";
import { SessionBar } from "./session-bar";
import { SplitPane } from "./split-pane";
import { TranscriptBody } from "./transcript-body";
import { VoiceChat } from "./voice-chat";
import { VoiceSummary } from "./voice-summary";

/**
 * 전사문 한 편.
 *
 * **가운데가 본문, 오른쪽 날개에 대화(위)와 요약(아래).** 그 사이는 끌 수 있는
 * 칸막이라 사람마다 원하는 비율로 둘 수 있다 — PaperBento 의 논문 상세와 같은
 * `split-pane.tsx` 를 그대로 쓴다.
 *
 * 좁아지면(xl 미만) 칸막이가 사라지고 위아래로 쌓이는데, 그때는 **본문이
 * 먼저**다. PaperBento 는 반대로 글을 위에 두는데(원문이 세로로 길어 위에
 * 놓으면 요약까지 한참 굴려야 한다), 여기서는 본문 자체가 이 화면의 주인공이고
 * 대화는 그 글을 읽다가 묻는 것이라 아래가 맞다.
 *
 * ## 재생기는 칸막이 위에 하나
 *
 * 본문 칸 안에 넣으면 오른쪽 날개를 보는 동안 재생 조작이 화면 밖으로 나간다.
 * 위에 걸어 두면 어느 칸을 보든 손이 닿는다.
 *
 * ## 도는 동안에도 들어올 수 있다
 *
 * 전사 중에 들어오면 진행 표시가 뜨고, 끝나면 그 자리에서 글이 채워진다.
 * 다 될 때까지 못 들어오게 막지 않는다 — 60분짜리는 6분이 걸린다.
 */

/*
 * 칸 비율과 접힘을 기억할 자리.
 *
 * `voicebento.` 접두어를 붙인다. 한 도메인에 `/voice` 와 `/memo` 와 `/paper` 를
 * 나란히 얹으면 오리진이 같아지고, localStorage 는 경로를 구분하지 않아 네 앱이
 * 같은 칸을 쓰게 된다. 앱 이름으로 갈라 두지 않으면 여기서 끈 폭이 옆 앱의
 * 칸막이를 움직인다 — PaperBento 가 같은 이유로 같은 규칙을 지킨다.
 */
const SPLIT_KEY = "voicebento.transcriptSplit";
const COLLAPSE_KEY = "voicebento.rightCollapsed";
const FOLLOW_KEY = "voicebento.followPlayback";

/** 도는 것이 있을 때 다시 물어보는 간격. */
const POLL_MS = 2500;

export function TranscriptView({
  recordingId,
  mailbentoUrl,
  memobentoUrl,
  paperbentoUrl,
}: {
  recordingId: string;
  mailbentoUrl?: string | null;
  memobentoUrl?: string | null;
  paperbentoUrl?: string | null;
}) {
  const [recording, setRecording] = useState<RecordingWithSession | null>(null);
  const [segments, setSegments] = useState<SegmentDTO[]>([]);
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [notice, setNotice] = useState<RecordingNoticeDTO | null>(null);
  const [polishError, setPolishError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelNoticeDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 다듬기가 같은 세션의 다른 녹음 뒤에 줄을 섰다면 그 수. */
  const [polishQueued, setPolishQueued] = useState<number | null>(null);

  const [collapsed, setCollapsed] = useState(false);
  const [following, setFollowing] = useState(true);
  const [hasActive, setHasActive] = useState(false);

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const composing = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const jumpRef = useRef<(() => void) | null>(null);

  // 기억해 둔 값은 **붙은 뒤에** 읽는다. 그릴 때 읽으면 서버가 그린 것과
  // 달라져 하이드레이션이 어긋난다 — localStorage 는 서버에 없다.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
      const f = localStorage.getItem(FOLLOW_KEY);
      if (f !== null) setFollowing(f === "1");
    } catch {
      /* 사생활 보호 모드 등 — 기본값으로 산다 */
    }
  }, []);

  const remember = (key: string, on: boolean) => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* 못 적어도 이번 화면에서는 잘 돌아간다 */
    }
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const j = await api.detail(recordingId, signal);
        setRecording(j.recording);
        setSegments(j.segments ?? []);
        setSession(j.session ?? null);
        setNotice(j.notice ?? null);
        setPolishError(j.polishError ?? null);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "녹음을 불러오지 못했습니다");
      } finally {
        setLoading(false);
      }
    },
    [recordingId],
  );

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  /*
   * 모델 서술자.
   *
   * 상세 응답에는 안 실려 오므로 목록에서 받아 온다. 이 화면이 서술자를
   * **꼭** 알아야 하는 이유는 두 가지다: 전사문이 비었을 때 "이 모델이 모르는
   * 말일 수 있다" 를 적어야 하고, `timestamps` 가 `"none"` 인 모델이면
   * **낱말 클릭을 접어야** 한다. 둘 다 화면에 박아 두면 모델을 갈아 끼운 날
   * 여기만 옛말이 남는다.
   */
  useEffect(() => {
    const ctl = new AbortController();
    api
      .list(ctl.signal)
      .then((j) => setModel(j.model ?? null))
      .catch(() => undefined);
    return () => ctl.abort();
  }, []);

  const cap = useMemo(() => readModel(model), [model]);

  /**
   * 어느 세션에서 도는지, 이름만.
   *
   * 온전한 서술(`session`)이 먼저이고, 없으면 녹음에 붙어 온 이름을 쓴다.
   * 대화창과 다듬기 상자는 이름만 알면 되므로 여기서 하나로 좁힌다.
   */
  const sessionName = session?.name ?? recording?.sessionName ?? null;

  // 도는 동안에는 계속 물어본다. 끝나면 멈춘다.
  const busy = recording ? isBusy(recording.state) : false;
  useEffect(() => {
    if (!busy) return;
    const ctl = new AbortController();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load(ctl.signal);
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      ctl.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [busy, load]);

  // 다듬기가 끝나면 "줄 섰습니다" 안내를 걷는다. 남겨 두면 다 끝난 화면에
  // 기다리라는 말이 붙어 있게 된다.
  useEffect(() => {
    if (recording && recording.state !== "polishing") setPolishQueued(null);
  }, [recording]);

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = t;
    void el.play().catch(() => undefined);
  }, []);

  const onActiveChange = useCallback((has: boolean) => setHasActive(has), []);

  const onFollowingChange = useCallback((v: boolean) => {
    setFollowing(v);
    remember(FOLLOW_KEY, v);
  }, []);

  /**
   * 한 줄을 고쳐 저장한다.
   *
   * 서버가 돌려준 조각으로 **통째로 갈아 끼운다.** 화면이 들고 있던 값에
   * 패치만 얹지 않는 것은 `edited` 때문이다 — 그 깃발은 서버가 켠다. 화면이
   * 짐작해서 켜 두면, 서버가 안 켰을 때 "고침" 표시만 있고 다음 다듬기는
   * 이 줄을 덮어쓰는 어긋난 상태가 된다.
   */
  const onSaveSegment = useCallback(
    async (sid: string, patch: { text?: string; speaker?: string | null }) => {
      try {
        const next = await api.patchSegment(recordingId, sid, patch);
        setSegments((prev) => prev.map((s) => (s.id === sid ? next : s)));
      } catch (e) {
        setError(e instanceof Error ? e.message : "줄을 저장하지 못했습니다");
        throw e;
      }
    },
    [recordingId],
  );

  const onPolish = useCallback(
    async (context: string) => {
      const started = await api.polish(recordingId, context);
      /*
       * 같은 세션에 다듬기가 겹치면 서버가 줄을 세운다 — 한 세션에
       * `--resume` 이 둘 겹치면 대화가 서로를 덮어쓰기 때문이다. 그 사실이
       * 화면에 안 보이면 "눌렀는데 아무 일도 안 난다" 가 되어 한 번 더 누른다.
       */
      setPolishQueued(started?.queued ? (started.aheadInSession ?? 0) : null);
      // 202 만 온다. 상태를 먼저 옮겨 두지 않으면 누른 자리가 그대로라
      // 한 번 더 누르게 된다. 진짜 상태는 곧 폴링이 가져온다.
      setRecording((r) => (r ? { ...r, state: "polishing", error: null } : r));
    },
    [recordingId],
  );

  const onRetranscribe = async () => {
    if (
      !confirm(
        "이 녹음을 처음부터 다시 옮깁니다. 지금 전사문과 직접 고친 줄이 모두 사라집니다. 진행할까요?",
      )
    ) {
      return;
    }
    try {
      await api.retranscribe(recordingId);
      setRecording((r) => (r ? { ...r, state: "queued", progress: null, error: null } : r));
      setSegments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "다시 전사를 시작하지 못했습니다");
    }
  };

  const commitTitle = async () => {
    const next = titleDraft.trim();
    if (!recording || !next || next === recording.title) {
      setRenaming(false);
      return;
    }
    try {
      const updated = await api.rename(recordingId, next);
      setRecording(updated);
      setRenaming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "이름을 바꾸지 못했습니다");
    }
  };

  /**
   * 옮겨진 말이 거의 없는가.
   *
   * 서버가 알아챈 것(`notice`)이 있으면 그것이 먼저다 — 이 녹음을 실제로 본
   * 쪽의 판단이다. 없더라도 화면이 직접 본다. 그 말이 어느 쪽 사정으로든
   * 화면에서 빠지는 것이 가장 나쁜 결과이기 때문이다.
   */
  const emptyish = useMemo(() => {
    if (!recording || recording.state !== "done") return false;
    if (notice) return true;
    if (segments.length === 0) return true;
    const withText = segments.filter((s) => s.text.trim().length > 0).length;
    return withText / segments.length < 0.1;
  }, [recording, segments, notice]);

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center">
        <p className="flex items-center gap-2 text-sm text-(--color-fg-4)">
          <Loader2 className="h-4 w-4 animate-spin" />
          전사문을 불러오는 중…
        </p>
      </main>
    );
  }

  if (!recording) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertCircle className="h-6 w-6 text-(--color-danger)" />
          <p className="text-sm break-keep text-(--color-fg-2)">
            {error ?? "이 녹음을 찾을 수 없습니다"}
          </p>
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-full bg-(--color-surface) px-4 py-2 text-sm text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-2)"
          >
            <ArrowLeft className="h-4 w-4" />
            목록으로
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col gap-4 px-4 py-5 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-(--color-surface) text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-2)"
            aria-label="목록으로"
            title="목록으로"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          <div className="min-w-0">
            {renaming ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => {
                  const c = (e.nativeEvent as InputEvent).isComposing;
                  if (typeof c === "boolean") composing.current = c;
                  setTitleDraft(e.target.value);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onBlur={() => {
                  composing.current = false;
                  void commitTitle();
                }}
                onKeyDown={(e) => {
                  // 조합 중의 Enter 는 IME 의 것이다. 가로채면 마지막 음절이 날아간다.
                  if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitTitle();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenaming(false);
                  }
                }}
                className="w-[min(28rem,70vw)] rounded-lg bg-(--color-bg-2) px-3 py-1.5 text-lg text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
                aria-label="녹음 이름"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(recording.title);
                  setRenaming(true);
                }}
                title="눌러서 이름 고치기"
                className="group flex min-w-0 items-center gap-2 text-left"
              >
                <h1
                  className="truncate text-xl leading-tight text-(--color-fg)"
                  style={{ fontFamily: "var(--font-notebook-title)" }}
                >
                  {recording.title}
                </h1>
                <Pencil className="h-3 w-3 shrink-0 text-(--color-fg-4) opacity-0 transition group-hover:opacity-100" />
              </button>
            )}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-(--color-fg-4)">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatLength(recording.duration)}
              </span>
              <span aria-hidden>·</span>
              <span>줄 {segments.length}</span>
              <StateBadge state={recording.state} className="ml-1" />
              {/*
                어느 세션에서 도는지. 제목 바로 아래에 두는 것은 오른쪽 날개에
                무엇을 묻기 전에 **지금 누구와 이야기하는지**가 보여야 하기
                때문이다 — 세션이 다르면 같은 질문에 다른 답이 온다.
              */}
              <SessionBar
                session={session}
                /*
                  상세 응답이 세션을 안 실어 줘도 녹음에는 `sessionId`·
                  `sessionName` 이 붙어 온다. 그것만으로도 "세션 없음" 이라는
                  거짓말은 막을 수 있다 — 붙어 있는데 안 붙었다고 적으면
                  사람이 같은 세션을 하나 더 만든다.
                */
                fallback={
                  recording.sessionId
                    ? { id: recording.sessionId, name: recording.sessionName ?? "이름 없는 세션" }
                    : null
                }
                recordingId={recording.id}
                onMoved={(next) => {
                  setSession(next);
                  setRecording((r) => (r ? { ...r, sessionId: next?.id ?? null } : r));
                }}
                onUpdated={setSession}
                className="ml-1"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PolishPanel
            recordingId={recording.id}
            segments={segments}
            state={recording.state}
            sessionName={sessionName}
            onRun={onPolish}
          />

          <button
            type="button"
            onClick={() => void onRetranscribe()}
            disabled={isBusy(recording.state)}
            title="처음부터 다시 옮깁니다. 지금 전사문은 사라집니다"
            className="flex items-center gap-1.5 rounded-full bg-(--color-surface) px-3 py-1.5 text-xs text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-2) disabled:opacity-40"
          >
            <ListRestart className="h-3.5 w-3.5" />
            다시 전사
          </button>

          {/*
            오른쪽 칸 접기.

            머리말에 둔다 — **접힌 상태에서도 보여야 하기 때문이다.** 대화 카드
            머리말에 얹으면 접는 순간 그 단추가 함께 사라져 다시 펼 길이 없어진다.
            켜짐/꺼짐을 색으로만 가르지 않는다: 글자와 아이콘 방향이 함께 바뀌고,
            낭독기에는 `aria-pressed` 로 간다.
          */}
          <button
            type="button"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              remember(COLLAPSE_KEY, next);
            }}
            aria-pressed={collapsed}
            title={collapsed ? "대화·요약 칸을 다시 펼칩니다" : "대화·요약 칸을 접고 전사문만 크게 봅니다"}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ring-1 transition",
              collapsed
                ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40 hover:bg-(--color-accent)/25"
                : "bg-(--color-surface) text-(--color-fg-2) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
            )}
          >
            {collapsed ? (
              <PanelRightOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelRightClose className="h-3.5 w-3.5" />
            )}
            {collapsed ? "칸 펴기" : "칸 접기"}
          </button>

          <CrossAppLink app="memobento" href={memobentoUrl} />
          <CrossAppLink app="paperbento" href={paperbentoUrl} />
          <CrossAppLink app="mailbento" href={mailbentoUrl} />
        </div>
      </header>

      {busy && (
        <section className="rounded-[var(--radius-app)] bg-(--color-surface) px-4 py-3 ring-1 ring-(--color-border-soft)">
          <JobProgress recording={recording} rtf={cap.rtf} />
        </section>
      )}

      {recording.state === "failed" && recording.error && (
        <p className="flex items-start gap-2 rounded-[var(--radius-app)] bg-(--color-danger)/10 px-4 py-3 text-xs leading-relaxed break-keep text-(--color-danger) ring-1 ring-(--color-danger)/25">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{recording.error}</span>
        </p>
      )}

      {polishQueued !== null && (
        /*
          같은 세션에 다듬기가 겹쳤다. 오류가 아니라 **차례**라서 경고색도
          붉은색도 아니다. 한 세션에 `--resume` 이 둘 겹치면 대화가 서로를
          덮어쓰기 때문에 서버가 줄을 세운다 — 그 규율이 이 앱을 조용히
          망가뜨리지 않게 하는 것이라, 기다림을 감추지 않고 그대로 적는다.
        */
        <p className="flex items-start gap-2 rounded-[var(--radius-app)] bg-(--color-surface) px-4 py-2.5 text-[11.5px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-(--color-accent)" />
          <span className="min-w-0">
            같은 세션의 다른 녹음이 먼저 다듬는 중입니다. 앞에 {polishQueued}건이 있어 차례를
            기다립니다 — 한 세션에서 둘이 동시에 돌면 대화가 서로를 덮어씁니다.
          </span>
        </p>
      )}

      {polishError && (
        /*
          다듬기가 실패한 것은 **전사가 실패한 것과 다른 일이다.** 전사문은
          멀쩡히 있고 화자만 안 붙은 상태라, 위의 붉은 띠와 같은 무게로
          말하면 사람이 전사까지 날아간 줄 안다.

          **문장을 여기서 짓지 않는다.** 이 칸(`polishError`)에는 두 가지가
          온다 — 진짜 실패("에이전트에 닿지 못했습니다")와, 성공했지만 알려야
          할 것("표시된 줄 3개: …"). 앞에 "다듬기가 끝나지 못했습니다" 를
          붙이면 뒤엣것이 실패로 둔갑한다. 표시를 붙이는 것은 이 기능이
          제대로 돈 결과인데 화면이 그것을 고장이라고 말하는 셈이다.
          서버가 보낸 문장은 둘 다 그 자체로 완결되어 있으니 그대로 싣고,
          우리는 둘 다에 참인 말만 덧붙인다.
        */
        <p className="flex items-start gap-2 rounded-[var(--radius-app)] bg-(--color-warn)/10 px-4 py-2.5 text-[11.5px] leading-relaxed break-keep text-(--color-warn) ring-1 ring-(--color-warn)/25">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {polishError} 옮긴 글은 그대로 있습니다. 뜻대로 되지 않았다면 다시 눌러 보세요.
          </span>
        </p>
      )}

      {recording.fileId ? (
        <AudioBar
          src={audioUrl(recording.id)}
          audioRef={audioRef}
          following={following}
          onFollowingChange={onFollowingChange}
          onJumpToActive={() => jumpRef.current?.()}
          hasActive={hasActive}
        />
      ) : (
        <p className="rounded-[var(--radius-app)] bg-(--color-surface) px-4 py-3 text-xs break-keep text-(--color-fg-4) ring-1 ring-(--color-border-soft)">
          이 녹음에는 붙어 있는 파일이 없습니다. 글은 보고 고칠 수 있지만 재생은 안 됩니다.
        </p>
      )}

      <SplitPane
        className="flex-1"
        collapsed={collapsed}
        storageKey={SPLIT_KEY}
        defaultRatio={0.62}
        minRatio={0.35}
        maxRatio={0.78}
        // 좁아져 위아래로 쌓이면 **본문이 먼저**다. 대화는 그 글을 읽다가 묻는 것이다.
        stackFirst="left"
        label="전사문과 대화 사이 폭 조절"
        /*
          본문은 오른쪽 날개를 굴려도 제자리에 있어야 하므로 sticky 다.
          `self-start` 가 함께 있어야 한다 — flex 칸은 기본이 늘어나기(stretch)라
          이미 줄 높이만큼 커져 있고, 그러면 붙을 여지가 없어 sticky 가 아무것도
          안 한다. 높이를 화면에 맞추는 것은 따라가기 때문이다: 본문이 제 상자
          안에서 굴러야 재생을 따라 굴릴 자리가 생긴다.
        */
        leftClassName="h-[calc(100vh-15rem)] min-h-[24rem] xl:sticky xl:top-4 xl:self-start"
        rightClassName="gap-4"
        left={
          <TranscriptBody
            segments={segments}
            audioRef={audioRef}
            following={following}
            onFollowingChange={onFollowingChange}
            onActiveChange={onActiveChange}
            jumpRef={jumpRef}
            notice={notice}
            cap={cap}
            showEmptyNotice={emptyish}
            onSave={onSaveSegment}
            className="h-full"
          />
        }
        right={
          <>
            <VoiceChat
              recordingId={recording.id}
              recordingTitle={recording.title}
              sessionName={sessionName}
              onSeek={seek}
            />
            <VoiceSummary recordingId={recording.id} state={recording.state} />
          </>
        }
      />

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

      {/* 저장이 끝났다는 신호. 줄을 고치면 곧바로 서버로 가므로 그 사실이 보여야 한다. */}
      <span className="sr-only" aria-live="polite">
        {segments.filter((s) => s.edited).length > 0
          ? `직접 고친 줄 ${segments.filter((s) => s.edited).length}개`
          : ""}
      </span>
    </main>
  );
}
