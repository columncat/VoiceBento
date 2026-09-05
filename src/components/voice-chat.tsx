"use client";

import {
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { RichText } from "@/components/rich-text";
import { api } from "@/lib/client-api";
import { HttpError } from "@/lib/read-json";
import type { ChatStatus, ChatTurn } from "@/lib/types";
import { cn } from "@/lib/utils";

import { formatClock } from "./format";

/**
 * 이 녹음에 대해 묻는 자리. 오른쪽 날개의 **위쪽**이다.
 *
 * PaperBento 의 `paper-chat.tsx` 를 그대로 본떴다 — 폴링 간격, 진행 표시 문구,
 * 답을 `RichText` 로 그리는 것, 큰 창의 치수(`h-[92vh] w-[min(1080px,96vw)]`),
 * 늦게 온 답을 버리는 번호표, IME 가드까지. 두 앱을 오가는 사람에게 같은
 * 창이어야 한다.
 *
 * 저 파일을 공용으로 뽑아 쓰지 않은 이유도 같다. `agent-chat.tsx` 가 세 앱에
 * 바이트까지 같은 채로 있는데, 몸통을 뽑아 함께 쓰려면 저기를 고쳐야 하고 그
 * 순간 여러 벌이 갈라진다. 다음에 합칠 때 아픈 것은 그 갈라짐이지 파일 수가
 * 아니다.
 *
 * ## 여기만 다른 것: 답 속의 시각
 *
 * 전사문을 읽은 답에는 "12:30 쯤에 그 이야기가 나옵니다" 같은 말이 자주 섞인다.
 * 그 숫자를 눈으로 읽고 재생기를 손으로 끌어 맞추는 것은 번거롭다. 그래서 답
 * 아래에 **그 답에 나온 시각들**을 알약으로 모아 두고, 누르면 거기서 재생한다.
 *
 * `rich-text.tsx` 를 고쳐 본문 안의 숫자를 단추로 바꾸는 길도 있었지만 안 골랐다.
 * 그 파일은 네 앱에 바이트까지 같은 채로 있고, 여기서 한 줄을 더하는 순간
 * 갈라진다. 밖에 두면 렌더러는 그대로 두고 이 앱만 얻는다.
 */

/** 물어보는 간격. 형제 앱들과 같은 값이다 — 같은 터널 뒤에 있다. */
const POLL_MS = 2000;

/** 인라인일 때 대화가 차지하는 최대 높이. 넘으면 이 안에서 구른다. */
const INLINE_LIST_MAX = "max-h-[240px]";

/**
 * 답에서 시각을 뽑는다.
 *
 * `12:34`·`1:02:03` 같은 모양만 본다. 앞뒤에 무엇이 붙어 있어도 상관없다 —
 * 대괄호로 감싸 달라고 에이전트에게 시켜 두는 방법도 있지만, 시키는 대로 안
 * 하는 날이 반드시 온다. 모양만 보면 시키지 않아도 잡힌다.
 *
 * 60분을 넘는 분(分)은 버린다. `1:99` 는 시각이 아니라 대개 다른 숫자다.
 */
function timesIn(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const re = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = m[1] ? Number(m[1]) : 0;
    const total = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (seen.has(total)) continue;
    seen.add(total);
    out.push(total);
    // 한 답에 시각이 스무 개 넘게 나오면 그건 목록이지 안내가 아니다.
    if (out.length >= 12) break;
  }
  return out;
}

interface Turn extends ChatTurn {
  denials?: string[];
  error?: boolean;
}

/** 우리가 스스로 끊은 것. 화면에 오류로 적지 않는다. */
class Dropped extends Error {}

function aborted(e: unknown): boolean {
  return e instanceof Dropped || (e instanceof Error && e.name === "AbortError");
}

/** `mcp__memobento__create_memo` → `memobento·create_memo`. 보기 위한 것뿐이다. */
function shortTool(name: string): string {
  return name.replace(/^mcp__/, "").replace(/__/g, "·");
}

export function VoiceChat({
  recordingId,
  recordingTitle,
  sessionName,
  onSeek,
  className,
}: {
  recordingId: string;
  recordingTitle: string;
  /**
   * 어느 세션에서 도는지. 안 붙어 있으면 null.
   *
   * 대화가 어느 세션에서 도는지는 **답이 달라지는 이유**다. 같은 세션이면
   * 방금 돌린 다듬기와 지난 회차의 녹음을 이어받고, 아니면 이 녹음만 본다.
   * 그 까닭이 화면 어디에도 없으면 앱이 변덕스러운 물건이 된다.
   */
  sessionName: string | null;
  /** 답에 나온 시각을 눌렀을 때. 재생기를 든 쪽이 넘겨준다. */
  onSeek: (t: number) => void;
  className?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  /** null 이면 아직 물어보는 중. 못 부르는 이유는 서버가 문장으로 준다. */
  const [agent, setAgent] = useState<{ ready: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ChatStatus | null>(null);
  const [big, setBig] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 보내는 중인가. 상태가 아니라 ref 인 이유는 `send()` 안에 적었다. */
  const sending = useRef(false);
  /**
   * 이번이 몇 번째 대화인가.
   *
   * 늦게 온 답이 화면을 뒤집지 못하게 하는 문지기다. "새 대화" 를 누르거나
   * 다음 질문을 보내면 번호가 오르고, 답이 돌아왔을 때 번호가 다르면 그
   * 답은 이미 없는 대화의 것이라 조용히 버린다.
   */
  const runSeq = useRef(0);
  /** 돌던 폴링을 끊는 손잡이. 화면을 떠나거나 대화를 지울 때 쓴다. */
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 한글을 조합하는 중인가. **키 처리의 보조 신호다.**
   *
   * 주 신호는 이벤트가 실어 오는 `isComposing` 이고, 그 값을 안 실어 주는 판이
   * 있어 이 깃발을 함께 본다.
   */
  const composing = useRef(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const j = await api.chat.history(recordingId);
      setAgent(j.agent);
      setTurns(j.turns);
    } catch (e) {
      // 기록을 못 불러온 것과 에이전트를 못 부르는 것은 다른 일이지만, 화면이
      // 할 수 있는 말은 같다 — 지금은 못 쓴다, 이유는 이것이다.
      setAgent({
        ready: false,
        reason: e instanceof Error ? e.message : "지난 대화를 불러오지 못했습니다",
      });
    } finally {
      setLoading(false);
    }
  }, [recordingId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // 화면을 떠나면 돌던 폴링을 끊는다. 답 자체는 에이전트 쪽에 남아 다음에
  // 들어올 때 기록으로 따라온다.
  useEffect(() => () => abortRef.current?.abort(), []);

  /*
   * 새 줄이 붙으면 바닥으로 내린다.
   *
   * `scrollIntoView` 를 쓰지 않는다 — 인라인 칸은 페이지 안에 있어서 그
   * 함수가 **페이지째** 굴린다. 읽던 자리가 질문 한 번에 튀어 오른다.
   */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy, big]);

  /*
   * 접혀 있는 동안 온 답도 다시 폈을 때 보여야 한다.
   *
   * 이 칸은 접히는 칸 안에 있고, 접는 것은 `display:none` 이라 언마운트가
   * 아니다 — 그래서 답이 붙어도 위 효과가 굴린 `scrollTop` 이 먹지 않는다
   * (숨은 상자는 높이가 0 이다). 다시 펴는 순간을 잡아 그때 한 번 내린다.
   *
   * **0 에서 살아나는 순간만** 본다. 폭이 바뀔 때마다 바닥으로 끌어내리면,
   * 앞의 답을 되짚어 읽으려고 올려 둔 자리가 칸막이를 끌 때마다 튕겨 나간다.
   */
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let hidden = el.clientHeight === 0;
    const ro = new ResizeObserver(() => {
      const shown = el.clientHeight > 0;
      if (shown && hidden) el.scrollTop = el.scrollHeight;
      hidden = !shown;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [big, loading, agent?.ready]);

  // 큰 창은 Esc 로도 닫힌다.
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBig(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [big]);

  useEffect(() => {
    if (big) inputRef.current?.focus();
  }, [big]);

  /**
   * 답이 나올 때까지 물어본다.
   *
   * 한 요청을 붙들고 기다리면 앞의 Cloudflare 터널이 100초에서 끊는다. 전사문
   * 전체를 읽는 답은 대개 그보다 오래 걸린다 — 시작만 시키고 짧게 여러 번 묻는다.
   */
  const poll = async (job: string, seq: number, signal: AbortSignal): Promise<ChatStatus> => {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (seq !== runSeq.current) throw new Dropped();
      let s: ChatStatus;
      try {
        s = await api.chat.status(recordingId, job, signal);
      } catch (e) {
        // 404 는 "그런 작업이 없다" 다 — 에이전트가 다시 떴다는 뜻이라 오류로
        // 던지기 전에 기록부터 다시 읽는다. 답이 어디까지 갔는지는 거기 있다.
        if (e instanceof HttpError && e.status === 404) {
          await loadHistory();
          throw new Error("에이전트가 다시 시작되어 이 요청은 사라졌습니다");
        }
        throw e;
      }
      if (seq !== runSeq.current) throw new Dropped();
      setProgress(s);
      if (s.state === "done") return s;
    }
  };

  const send = async () => {
    const message = draft.trim();
    // busy 는 상태라 곧바로 반영되지 않는다. Enter 를 연달아 치면 둘 다 통과해
    // 같은 질문이 두 번 들어간다. 문지기는 ref 로 둔다.
    if (!message || sending.current || agent?.ready !== true) return;
    sending.current = true;
    const seq = (runSeq.current += 1);
    const ctl = new AbortController();
    abortRef.current = ctl;

    setDraft("");
    setTurns((t) => [...t, { role: "me", text: message, at: Date.now() }]);
    setBusy(true);
    setProgress(null);
    try {
      const { id } = await api.chat.send(recordingId, message);
      if (!id) throw new Error("에이전트가 작업 번호를 주지 않았습니다");
      const done = await poll(id, seq, ctl.signal);
      setTurns((t) => [
        ...t,
        {
          role: "agent",
          text: done.reply ?? "[빈 응답]",
          at: Date.now(),
          denials: done.denials,
          error: done.isError === true,
        },
      ]);
    } catch (e) {
      if (aborted(e) || seq !== runSeq.current) return;
      setTurns((t) => [
        ...t,
        {
          role: "agent",
          text:
            e instanceof HttpError && e.status === 401
              ? "로그인이 풀렸습니다. 새로고침해서 다시 로그인한 뒤 이어 주세요. 보낸 말은 서버에서 계속 처리되고 있을 수 있습니다."
              : e instanceof Error
                ? e.message
                : String(e),
          at: Date.now(),
          error: true,
        },
      ]);
    } finally {
      // 이미 다음 대화가 시작됐으면 그쪽 표시를 건드리지 않는다.
      if (seq === runSeq.current) {
        setBusy(false);
        setProgress(null);
      }
      sending.current = false;
    }
  };

  const reset = async () => {
    if (
      !confirm(
        "이 녹음의 대화를 지웁니다. 다른 녹음의 대화와 Discord 쪽 맥락은 그대로입니다. 진행할까요?",
      )
    ) {
      return;
    }
    // 번호를 먼저 올린다. 돌던 답이 빈 대화에 끼어들지 못한다.
    runSeq.current += 1;
    abortRef.current?.abort();
    setBusy(false);
    setProgress(null);
    setTurns([]);
    await api.chat.reset(recordingId).catch(() => undefined);
  };

  const canSend = agent?.ready === true && !busy && draft.trim().length > 0;

  // ── 조각들 ──────────────────────────────────────────────

  const header = (inBig: boolean) => (
    <header
      className={cn(
        "flex shrink-0 items-center justify-between gap-2",
        inBig ? "border-b border-(--color-border-soft) px-5 py-3.5" : "px-5 py-3",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0 text-(--color-accent-strong)" />
        <span className="shrink-0 text-sm font-medium text-(--color-fg)">
          이 녹음에 대해 질문하기
        </span>
        {inBig && (
          <span className="truncate text-[11px] text-(--color-fg-4)" title={recordingTitle}>
            {recordingTitle}
          </span>
        )}
        {sessionName && (
          <span
            className="min-w-0 shrink truncate rounded-full bg-(--color-bg-2) px-2 py-0.5 text-[10.5px] text-(--color-fg-4)"
            title={`세션 "${sessionName}" 에서 돕니다 — 같은 세션의 지난 녹음과 방금 다듬은 결과를 이어받습니다`}
          >
            {sessionName}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {turns.length > 0 && agent?.ready === true && (
          <button
            type="button"
            onClick={() => void reset()}
            className="grid h-8 w-8 place-items-center rounded-lg text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            aria-label="새 대화"
            title="새 대화 — 이 녹음의 대화만 지웁니다"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        {/* 못 부르는 칸을 크게 펼쳐 봐야 빈 창이다. 이유는 인라인에 이미 적혀 있다. */}
        {(agent?.ready === true || inBig) && (
          <button
            type="button"
            onClick={() => setBig((v) => !v)}
            className="grid h-8 w-8 place-items-center rounded-lg text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            aria-label={inBig ? "작게 보기" : "크게 보기"}
            title={inBig ? "작게 보기 (Esc)" : "크게 보기"}
          >
            {inBig ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
        {inBig && (
          <button
            type="button"
            onClick={() => setBig(false)}
            className="grid h-8 w-8 place-items-center rounded-lg text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            aria-label="닫기"
            title="닫기 (Esc)"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        )}
      </div>
    </header>
  );

  const list = (inBig: boolean) => (
    <div
      ref={listRef}
      className={cn(
        "scrollbar-thin space-y-3 overflow-y-auto",
        inBig ? "min-h-0 flex-1 px-5 py-4" : cn(INLINE_LIST_MAX, "px-5 pb-3"),
      )}
    >
      {turns.length === 0 && !busy && (
        <p
          className={cn(
            "text-center break-keep text-(--color-fg-4)",
            inBig ? "px-1 py-12 text-sm" : "px-1 py-4 text-[12px]",
          )}
        >
          이 녹음의 전사문을 읽고 답합니다. 무슨 이야기였는지, 무엇이 정해졌는지, 어느 대목에
          그 말이 나오는지 물어보세요.
          {sessionName && (
            <>
              {" "}
              세션 <b className="font-medium text-(--color-fg-3)">{sessionName}</b> 에서 도는
              대화라, 방금 다듬은 결과와 같은 세션의 지난 녹음도 이어받습니다.
            </>
          )}
        </p>
      )}
      {turns.map((t, i) => {
        const stamps = t.role === "agent" && !t.error ? timesIn(t.text) : [];
        return (
          <div
            key={i}
            className={cn(
              "rounded-xl px-4 py-2.5 leading-relaxed",
              inBig ? "max-w-[min(72ch,88%)] text-sm" : "max-w-[92%] text-[13px]",
              t.role === "me"
                ? "ml-auto bg-(--color-accent-soft) text-(--color-accent-strong)"
                : t.error
                  ? "bg-(--color-danger)/15 text-(--color-danger)"
                  : "bg-(--color-bg-2) text-(--color-fg-2)",
            )}
          >
            {/*
              내가 쓴 말은 쓴 그대로 둔다. 서식을 입히면 내가 친 별표가 사라져
              무슨 말을 보냈는지 되짚을 수 없다.
            */}
            {t.role === "me" || t.error ? (
              <span className="whitespace-pre-wrap">{t.text}</span>
            ) : (
              <RichText text={t.text} />
            )}

            {stamps.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span className="text-[10.5px] text-(--color-fg-4)">들어보기</span>
                {stamps.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      onSeek(s);
                      // 큰 창이 떠 있으면 소리는 나는데 화면은 창에 가려 있다.
                      // 들으러 간 것이니 창을 닫아 전사문을 보여 준다.
                      setBig(false);
                    }}
                    className="flex items-center gap-1 rounded-full bg-(--color-surface) px-2 py-0.5 font-mono text-[10.5px] text-(--color-accent-strong) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
                  >
                    <Play className="h-2.5 w-2.5" />
                    {formatClock(s)}
                  </button>
                ))}
              </div>
            )}

            {t.denials && t.denials.length > 0 && (
              <p className="mt-1.5 text-[11px] text-(--color-warn)">
                허용되지 않은 도구를 쓰려고 했습니다: {t.denials.join(", ")}
              </p>
            )}
          </div>
        );
      })}
      {busy && (
        <div className="flex items-center gap-2 text-[12px] text-(--color-fg-4)">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {progress ? (
            <span>
              {Math.round(progress.elapsedMs / 1000)}초째
              {/* 0 이면 아무것도 안 적는다. "도구 0회" 는 알려 주는 것이 없다. */}
              {!!progress.toolCount && ` · 도구 ${progress.toolCount}회`}
              {progress.lastTool && (
                <span className="ml-1 font-mono text-[11px] text-(--color-fg-4)">
                  {shortTool(progress.lastTool)}
                </span>
              )}
            </span>
          ) : (
            <span>생각하는 중…</span>
          )}
        </div>
      )}
    </div>
  );

  const form = (inBig: boolean) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className={cn(
        "flex shrink-0 gap-2",
        inBig ? "border-t border-(--color-border-soft) px-4 py-3.5" : "px-4 pt-1 pb-3",
      )}
    >
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          /*
            조합 여부는 이벤트가 실어 오는 값이 가장 믿을 만하다. 훅이 든
            깃발은 `compositionend` 를 놓치면 선 채로 남는데, 여기서 매번
            덮어써 주면 다음 글자 한 번에 풀린다.
          */
          const c = (e.nativeEvent as InputEvent).isComposing;
          if (typeof c === "boolean") composing.current = c;
          setDraft(e.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        // 조합 중에 떠나면 `compositionend` 가 안 오는 길이 있다. 여기서 푼다.
        onBlur={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          /*
           * 조합 중의 Enter 는 **IME 의 것이다.** 글자를 확정하려고 누른
           * 키인데 여기서 가로채면 "한국어" 를 치다가 "한국" 만 날아간다.
           * 형제 앱들과 같은 세 신호를 함께 본다 — 이벤트 값, 옛 신호인
           * keyCode 229, 그리고 깃발.
           */
          if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        rows={inBig ? 2 : 1}
        placeholder="무엇이 궁금한가요? (Enter 로 전송, Shift+Enter 로 줄바꿈)"
        className="scrollbar-thin min-w-0 flex-1 resize-none rounded-lg bg-(--color-bg-2) px-3.5 py-2.5 text-[13px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none placeholder:text-(--color-fg-4) focus:ring-(--color-accent)/60"
      />
      <button
        type="submit"
        disabled={!canSend}
        className="grid w-12 shrink-0 place-items-center rounded-lg bg-(--color-accent) text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-40"
        aria-label="보내기"
      >
        <Send className="h-4 w-4" />
      </button>
    </form>
  );

  /** 못 부를 때. 칸은 남기고 이유를 그 자리에 적는다. */
  const why = (
    <div className="px-5 pb-4">
      <p className="rounded-lg bg-(--color-bg-2) px-3 py-2.5 text-[12px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)">
        {agent?.reason ?? "에이전트를 부를 수 없습니다."}
      </p>
      <button
        type="button"
        onClick={() => void loadHistory()}
        className="mt-2 rounded-full bg-(--color-bg-2) px-3 py-1 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
      >
        다시 확인
      </button>
    </div>
  );

  const loadingLine = (
    <p className="flex items-center gap-2 px-5 pb-4 text-[12px] text-(--color-fg-4)">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      에이전트를 확인하는 중…
    </p>
  );

  const inner = (inBig: boolean) =>
    loading ? (
      loadingLine
    ) : agent?.ready !== true ? (
      why
    ) : (
      <>
        {list(inBig)}
        {form(inBig)}
      </>
    );

  return (
    <>
      <section
        className={cn(
          "flex flex-col rounded-[var(--radius-card)] bg-(--color-surface) ring-1 ring-(--color-border-soft)",
          className,
        )}
      >
        {header(false)}
        {/*
          큰 창으로 옮겨 갔을 때. 목록과 입력칸을 두 벌 그리지 않는다 — 같은
          대화가 화면 두 곳에 있으면 어느 쪽을 보는지 헷갈리고, 구르는 상자도
          둘이 된다. 대신 자리는 지킨다. 큰 창을 닫았을 때 화면이 안 튄다.
        */}
        {big && (
          <p className="px-5 pb-4 text-[12px] text-(--color-fg-4)">큰 창에서 보고 있습니다.</p>
        )}
        {!big && inner(false)}
      </section>

      {big &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
            <button
              type="button"
              aria-label="닫기"
              onClick={() => setBig(false)}
              className="absolute inset-0 cursor-default bg-(--color-bg)/70 backdrop-blur-[2px]"
            />
            {/*
              치수는 형제 앱들의 큰 창과 같다. 사람 눈에 두 창이 달라 보일
              이유가 없다.

              `document.body` 로 portal 한다. 이 칸은 접을 수 있는 오른쪽 칸
              안에 있어서(`split-pane.tsx` 의 `collapsed`), 접힌 조상 밑에
              그리면 `fixed` 여도 함께 사라진다.
            */}
            <section
              role="dialog"
              aria-modal="true"
              aria-label="이 녹음에 대해 질문하기"
              className="relative flex h-[92vh] w-[min(1080px,96vw)] flex-col overflow-hidden rounded-[var(--radius-card)] bg-(--color-surface) shadow-2xl ring-1 ring-(--color-border-soft)"
            >
              {header(true)}
              {inner(true)}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
