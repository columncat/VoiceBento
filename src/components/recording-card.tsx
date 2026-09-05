"use client";

import { Check, Clock, ListRestart, Pencil, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { RecordingDTO } from "@/lib/types";
import { cn, formatRelativeTime } from "@/lib/utils";

import { formatLength } from "./format";
import { JobProgress, StateBadge, isBusy } from "./job-state";

/**
 * 녹음 한 건. 목록에 깔리는 카드.
 *
 * MemoBento 의 메모함 카드를 닮게 두되 **누르면 전사문이 열린다.** 그래서
 * 카드 몸통은 통째로 링크이고, 손질하는 단추(이름 고치기·지우기)는 링크
 * **밖에** 따로 있다. 링크 안에 단추를 넣으면 브라우저마다 다르게 굴고,
 * 낭독기에서는 "링크 안의 단추" 라는 없는 물건이 된다.
 *
 * ## 도는 중에도 들어갈 수 있다
 *
 * 전사가 도는 동안 카드를 막지 않는다. 들어가면 전사문 화면이 같은 진행
 * 표시를 띄우고, 다 되면 그 자리에서 글이 채워진다. 60분짜리는 6분쯤 걸리는데
 * 그동안 아무 데도 못 들어가게 하면 사람은 목록만 보며 기다린다.
 */
export function RecordingCard({
  recording,
  onRename,
  onDelete,
  onRetranscribe,
}: {
  recording: RecordingDTO;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRetranscribe: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(recording.title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 한글을 조합하는 중인가.
   *
   * 주 신호는 이벤트가 실어 오는 `isComposing` 이고, 그 값을 안 실어 주는 판이
   * 있어 이 깃발을 함께 본다 — 형제 앱들의 `search-panel.tsx`·`paper-chat.tsx`
   * 가 같은 이유로 같은 것을 들고 있다.
   */
  const composing = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // 바깥에서 이름이 바뀌면(에이전트가 고쳤거나 다른 창에서) 따라간다.
  // 다만 내가 고치는 중일 때는 손대지 않는다 — 적던 글자가 사라진다.
  useEffect(() => {
    if (!editing) setDraft(recording.title);
  }, [recording.title, editing]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === recording.title) {
      setEditing(false);
      setDraft(recording.title);
      return;
    }
    setSaving(true);
    try {
      await onRename(recording.id, next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const busy = isBusy(recording.state);

  return (
    <div className="group relative flex flex-col rounded-[var(--radius-card)] bg-(--color-surface) ring-1 ring-(--color-border-soft) transition hover:ring-(--color-border)">
      {editing ? (
        <div className="flex flex-col gap-2 p-5">
          <input
            ref={inputRef}
            value={draft}
            disabled={saving}
            onChange={(e) => {
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
            onBlur={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              /*
               * 조합 중의 Enter 는 **IME 의 것이다.** 글자를 확정하려고 누른
               * 키인데 여기서 가로채면 "회의록" 을 치다가 "회의" 만 저장된다.
               */
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(recording.title);
              }
            }}
            className="w-full rounded-lg bg-(--color-bg-2) px-3 py-2 text-sm text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
            aria-label="녹음 이름"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void commit()}
              disabled={saving}
              className="flex items-center gap-1 rounded-full bg-(--color-accent) px-3 py-1 text-[11px] text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              저장
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(recording.title);
              }}
              disabled={saving}
              className="flex items-center gap-1 rounded-full bg-(--color-bg-2) px-3 py-1 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              취소
            </button>
          </div>
        </div>
      ) : (
        <Link
          href={`/recordings/${recording.id}`}
          className="flex flex-1 flex-col gap-2 p-5 pr-16"
          title={`${recording.title} — 전사문 열기`}
        >
          <h2
            className="text-lg leading-snug break-keep text-(--color-fg) [overflow-wrap:anywhere]"
            style={{ fontFamily: "var(--font-notebook-title)" }}
          >
            {recording.title}
          </h2>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-(--color-fg-4)">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatLength(recording.duration)}
            </span>
            <span aria-hidden>·</span>
            <span title={new Date(recording.createdAt).toLocaleString("ko-KR")}>
              {formatRelativeTime(new Date(recording.createdAt).getTime())}
            </span>
          </p>

          {busy ? (
            <JobProgress recording={recording} className="mt-1" />
          ) : (
            <div className="mt-1">
              <StateBadge state={recording.state} />
            </div>
          )}

          {recording.state === "failed" && recording.error && (
            /*
              왜 실패했는지를 카드에 그대로 적는다. "실패" 알약만 있으면
              사람이 할 수 있는 일이 "다시 해 보기" 뿐인데, 이유를 보면
              (파일이 소리가 없다 / 자리가 없다 / 모델을 못 찾았다) 다시 해도
              같을지 아닐지를 안다.
            */
            <p className="mt-1 rounded-lg bg-(--color-danger)/10 px-2.5 py-1.5 text-[11px] leading-relaxed break-keep text-(--color-danger) ring-1 ring-(--color-danger)/25">
              {recording.error}
            </p>
          )}
        </Link>
      )}

      {!editing && (
        <div className="absolute top-3 right-3 flex items-center gap-0.5 opacity-60 transition group-hover:opacity-100 focus-within:opacity-100">
          {recording.state === "failed" && (
            <button
              type="button"
              onClick={() => void onRetranscribe(recording.id)}
              className="grid h-7 w-7 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-accent-strong)"
              aria-label="다시 전사"
              title="다시 전사"
            >
              <ListRestart className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="grid h-7 w-7 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            aria-label="이름 고치기"
            title="이름 고치기"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              // 되돌릴 수 없는 일이라 한 번 묻는다. 전사문과 올린 파일이 함께 사라진다.
              if (!confirm(`"${recording.title}" 을(를) 지웁니다. 전사문과 올린 파일이 함께 사라집니다. 진행할까요?`)) {
                return;
              }
              void onDelete(recording.id);
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-danger)"
            aria-label="지우기"
            title="지우기"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
