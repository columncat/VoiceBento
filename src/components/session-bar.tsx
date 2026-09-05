"use client";

import { AlertTriangle, ArrowRightLeft, Check, FolderPlus, Layers, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/client-api";
import type { SessionDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 전사문 화면에서 **이 녹음이 어느 세션에 있는지** 보여 주고 옮기는 자리.
 *
 * ## 왜 여기에도 세션이 보여야 하나
 *
 * 다듬기·대화·요약이 전부 이 세션에서 돈다. 그러니 오른쪽 날개에 무엇을
 * 물어보기 전에 **지금 누구와 이야기하고 있는지**가 보여야 한다. 세션이 다르면
 * 같은 질문에 다른 답이 온다 — 그 까닭이 화면 어디에도 없으면 앱이 변덕스러운
 * 물건이 된다.
 *
 * ## 왜 여기서 옮길 수 있어야 하나
 *
 * 올릴 때 고르는 기본값이 "새 세션" 이라, 지난 회차에 이어 붙이려던 것을
 * 놓치는 일이 반드시 생긴다. 그때 되돌릴 길이 없으면 녹음을 지우고 다시
 * 올리는 수밖에 없는데, 그건 한 시간짜리 파일을 다시 올리고 다시 6분을
 * 기다리는 일이다. 옮기기는 그 값을 없앤다.
 *
 * **지우기는 여기 없다.** 세션을 지우면 딸린 녹음이 전부 "세션 없음" 으로
 * 가는데, 이 화면에는 무엇이 딸려 있는지가 안 보인다. 지우기는 딸린 카드가
 * 함께 보이는 목록 화면에만 둔다.
 */
export function SessionBar({
  session,
  fallback,
  recordingId,
  onMoved,
  onUpdated,
  className,
}: {
  session: SessionDTO | null;
  /**
   * 상세 응답이 세션을 안 실어 줄 때 쓸 최소 정보. 녹음에 붙어 온
   * `sessionId`·`sessionName` 이다.
   *
   * 이 자리가 없으면 화면이 **"세션 없음" 이라고 거짓말한다** — 붙어 있는데
   * 안 붙었다고 적는 것은 아무 말도 안 하는 것보다 나쁘다. 사람이 그것을
   * 믿고 세션에 다시 넣으면 같은 세션이 둘이 된다.
   *
   * 맥락 눈금은 이때 안 그린다. 이름은 알아도 얼마나 찼는지는 모른다.
   */
  fallback: { id: string; name: string } | null;
  recordingId: string;
  /** 옮겨진 뒤 새 세션(또는 null). 위쪽이 상태를 갈아 끼운다. */
  onMoved: (next: SessionDTO | null) => void;
  /**
   * 세션 자체가 달라졌다 — 이름을 고쳤거나 맥락을 새로 시작했거나.
   *
   * 둘을 한 자리로 받는 것은 위쪽이 하는 일이 어느 쪽이든 같아서다:
   * 들고 있던 `SessionDTO` 를 새것으로 갈아 끼운다.
   */
  onUpdated: (next: SessionDTO) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const composing = useRef(false);

  /*
   * 목록은 **열 때** 받아 온다. 이 화면의 주인공은 전사문이라, 세션 목록을
   * 늘 들고 있으면 들어올 때마다 쓰지도 않을 요청이 하나 더 나간다.
   */
  useEffect(() => {
    if (!open || sessions !== null) return;
    let on = true;
    api.sessions
      .list()
      .then((list) => {
        if (on) setSessions(list);
      })
      .catch((e: unknown) => {
        if (on) setError(e instanceof Error ? e.message : "세션 목록을 불러오지 못했습니다");
      });
    return () => {
      on = false;
    };
  }, [open, sessions]);

  useEffect(() => {
    setRenameDraft(session?.name ?? fallback?.name ?? "");
  }, [session?.name, session?.id, fallback?.name, fallback?.id]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  const moveTo = (id: string | null) =>
    guard(async () => {
      await api.assign(recordingId, id);
      onMoved(id === null ? null : (sessions?.find((s) => s.id === id) ?? null));
      // 옮긴 뒤 목록은 낡았다(녹음 수가 바뀌었다). 다음에 열 때 다시 받는다.
      setSessions(null);
    });

  const createAndMove = () =>
    guard(async () => {
      const name = newName.trim();
      if (!name) return;
      const made = await api.sessions.create(name);
      await api.assign(recordingId, made.id);
      onMoved(made);
      setNewName("");
      setSessions(null);
    });

  const rename = () =>
    guard(async () => {
      if (!here) return;
      const next = renameDraft.trim();
      if (!next || next === here.name) return;
      onUpdated(await api.sessions.rename(here.id, next));
    });

  /**
   * 맥락만 새로 시작한다.
   *
   * 이름과 붙어 있는 녹음은 그대로 두고 **오간 대화만** 버린다. 되돌릴 수
   * 없으므로 한 번 묻고, 무엇이 남고 무엇이 사라지는지 묻는 말에 그대로 적는다.
   */
  const rollover = () => {
    if (!session) return;
    if (
      !confirm(
        `세션 "${session.name}" 의 에이전트 맥락을 새로 시작합니다.

` +
          `세션 이름과 붙어 있는 녹음 ${session.recordingCount}건, 전사문, 요약은 그대로 남습니다.
` +
          `사라지는 것은 그동안 오간 대화입니다 — 지난 회차에서 정한 화자 이름도 잊습니다.

` +
          `진행할까요?`,
      )
    ) {
      return;
    }
    void guard(async () => {
      onUpdated(await api.sessions.rollover(session.id));
    });
  };

  const used = session?.contextChars ?? 0;
  const limit = session?.contextLimit ?? 0;
  const full = session?.contextFull ?? false;
  /** 붙어 있는 세션의 id 와 이름. 온전한 서술이 없으면 최소 정보로. */
  const here = session ?? fallback;
  const others = (sessions ?? []).filter((s) => s.id !== here?.id);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
        }}
        aria-expanded={open}
        title={
          here
            ? `세션 "${here.name}" — 다듬기·대화·요약이 이 세션에서 돕니다`
            : "이 녹음은 어느 세션에도 붙어 있지 않습니다"
        }
        className={cn(
          "flex max-w-[18rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 transition",
          here
            ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/35 hover:bg-(--color-accent)/25"
            : "bg-(--color-bg-2) text-(--color-fg-4) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
        )}
      >
        <Layers className="h-3 w-3 shrink-0" />
        <span className="truncate">{here ? here.name : "세션 없음"}</span>
        {full && (
          // 맥락이 찼다. 알약 안에서도 보여야 한다 — 펼쳐 봐야 아는 것은 늦다.
          <AlertTriangle className="h-3 w-3 shrink-0 text-(--color-warn)" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute top-full left-0 z-30 mt-2 w-[min(26rem,calc(100vw-3rem))] rounded-lg bg-(--color-surface-2) p-3.5 shadow-lg ring-1 ring-(--color-border-soft)">
            <header className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs text-(--color-fg-2)">세션</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="닫기"
                className="rounded-full p-1 text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>

            <p className="mb-2.5 text-[11px] leading-relaxed break-keep text-(--color-fg-4)">
              다듬기·대화·요약이 모두 이 세션에서 돕니다. 같은 세션에 있는 지난 녹음의 화자
              이름과 용어를 이어받습니다.
            </p>

            {/* ── 이름 고치기 ─────────────────────────────── */}
            {here && (
              <div className="mb-3 flex items-center gap-1.5">
                <input
                  value={renameDraft}
                  disabled={busy}
                  onChange={(e) => {
                    const c = (e.nativeEvent as InputEvent).isComposing;
                    if (typeof c === "boolean") composing.current = c;
                    setRenameDraft(e.target.value);
                  }}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onBlur={() => {
                    composing.current = false;
                  }}
                  onKeyDown={(e) => {
                    // 조합 중의 Enter 는 IME 의 것이다. 가로채면 마지막 음절이 날아간다.
                    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void rename();
                    }
                  }}
                  aria-label="세션 이름"
                  className="min-w-0 flex-1 rounded-md bg-(--color-surface) px-2.5 py-1.5 text-[12px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
                />
                <button
                  type="button"
                  onClick={() => void rename()}
                  disabled={busy || !renameDraft.trim() || renameDraft.trim() === here.name}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-(--color-bg-2) px-2.5 py-1.5 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-40"
                >
                  <Check className="h-3 w-3" />
                  이름 저장
                </button>
              </div>
            )}

            {/* ── 맥락이 얼마나 찼나 ───────────────────────── */}
            {session && limit > 0 && (
              <div className="mb-3 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-[10.5px]">
                  <span className="text-(--color-fg-4)">세션 맥락</span>
                  <span className="font-mono tabular-nums text-(--color-fg-3)">
                    {used.toLocaleString()} / {limit.toLocaleString()}자
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-(--color-bg-2)">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      full ? "bg-(--color-warn)" : "bg-(--color-accent)",
                    )}
                    style={{
                      width: `${Math.max(2, Math.min(100, Math.round((used / limit) * 100)))}%`,
                    }}
                  />
                </div>

                {full && (
                  /*
                    상한에 닿았다. **조용히 자르지 않는다** — 잘라 보내면
                    에이전트가 못 본 대목을 "없다" 고 답하고, 없는 것과 우리가
                    안 보낸 것이 화면에서 같아진다. 그래서 서버가 거절하고,
                    사람이 두 갈래 중에서 고른다: 이 녹음을 새 세션으로 옮기거나
                    (아래 옮기기), 이 세션의 맥락만 새로 시작하거나.
                  */
                  <div className="flex flex-col gap-1.5 rounded-md bg-(--color-warn)/10 px-2 py-1.5 ring-1 ring-(--color-warn)/25">
                    <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed break-keep text-(--color-warn)">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="min-w-0">
                        상한에 닿아 더 다듬거나 물을 수 없습니다. 잘라 보내면 에이전트가 못 본
                        대목을 “없다” 고 답하기 때문에, 자르는 대신 멈춥니다.
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={rollover}
                      disabled={busy}
                      className="self-start rounded-full bg-(--color-warn)/15 px-2.5 py-1 text-[10.5px] text-(--color-warn) transition hover:bg-(--color-warn)/25 disabled:opacity-40"
                      title="세션 이름과 녹음·전사문은 그대로 두고 오간 대화만 버립니다"
                    >
                      맥락만 새로 시작
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── 옮기기 ──────────────────────────────────── */}
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-[11px] text-(--color-fg-4)">
                <ArrowRightLeft className="h-3 w-3" />이 녹음을 다른 세션으로
              </span>

              {sessions === null ? (
                <p className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-(--color-fg-4)">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  세션을 불러오는 중…
                </p>
              ) : (
                <>
                  {others.length > 0 && (
                    <ul className="scrollbar-thin flex max-h-[9rem] flex-col gap-1 overflow-y-auto">
                      {others.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void moveTo(s.id)}
                            className="flex w-full items-center justify-between gap-2 rounded-md bg-(--color-bg-2) px-2.5 py-1.5 text-left ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-40"
                          >
                            <span className="min-w-0 truncate text-[12px] text-(--color-fg-2)">
                              {s.name}
                            </span>
                            <span className="shrink-0 text-[10px] text-(--color-fg-4)">
                              녹음 {s.recordingCount}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex items-center gap-1.5">
                    <input
                      value={newName}
                      disabled={busy}
                      onChange={(e) => {
                        const c = (e.nativeEvent as InputEvent).isComposing;
                        if (typeof c === "boolean") composing.current = c;
                        setNewName(e.target.value);
                      }}
                      onCompositionStart={() => {
                        composing.current = true;
                      }}
                      onCompositionEnd={() => {
                        composing.current = false;
                      }}
                      onBlur={() => {
                        composing.current = false;
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current)
                          return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void createAndMove();
                        }
                      }}
                      placeholder="새 세션 이름"
                      aria-label="새 세션 이름"
                      className="min-w-0 flex-1 rounded-md bg-(--color-surface) px-2.5 py-1.5 text-[11.5px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
                    />
                    <button
                      type="button"
                      onClick={() => void createAndMove()}
                      disabled={busy || !newName.trim()}
                      className="flex shrink-0 items-center gap-1 rounded-full bg-(--color-bg-2) px-2.5 py-1.5 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-40"
                    >
                      <FolderPlus className="h-3 w-3" />
                      만들어 옮기기
                    </button>
                  </div>

                  {here && (
                    <button
                      type="button"
                      onClick={() => void moveTo(null)}
                      disabled={busy}
                      className="self-start rounded-full px-1 py-0.5 text-[10.5px] text-(--color-fg-4) underline decoration-dotted underline-offset-2 transition hover:text-(--color-fg-2) disabled:opacity-40"
                      title="세션에서 빼면 이 녹음만 따로 다듬고 대화하게 됩니다"
                    >
                      세션에서 빼기
                    </button>
                  )}
                </>
              )}
            </div>

            {error && (
              <p className="mt-2.5 flex items-start gap-1.5 rounded-md bg-(--color-danger)/10 px-2.5 py-1.5 text-[11px] break-keep text-(--color-danger) ring-1 ring-(--color-danger)/30">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">{error}</span>
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
