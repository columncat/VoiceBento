"use client";

import { Check, Layers, Pencil, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SessionDTO } from "@/lib/types";
import { cn, formatRelativeTime } from "@/lib/utils";

import { UploadButton } from "./upload-drop";

/**
 * 목록에서 세션 하나를 이끄는 머리말.
 *
 * 카드를 세션별로 묶어 보여 줄 때, 묶음마다 하나씩 선다. **여기에만 세션을
 * 지우는 단추가 있다** — 전사문 화면에서도 지울 수 있게 하면, 지금 보고 있는
 * 이 녹음 말고 무엇이 함께 딸려 있는지 모르는 채로 지우게 된다. 목록에서는
 * 딸린 카드가 바로 아래 보인다.
 *
 * ## "이 세션에 올리기"
 *
 * 파일을 고를 때 어디로 보낼지 묻는 화면(`session-picker.tsx`)의 기본값은
 * **새 세션**이다. 지난 회차에 이어 붙이는 것이 위험한 쪽이라 일부러 한 걸음
 * 멀리 두었는데, 그 한 걸음이 매번이면 이어 붙이기를 아무도 안 쓴다.
 * 그래서 **목적지가 이미 정해진 자리**에 지름길을 하나 둔다 — 이 머리말에서
 * 파일을 고르면 세션은 묻지 않고 이 세션으로 정해진다. 고른 자리가 곧 대답이다.
 *
 * **말한 사람 목록은 그래도 묻는다** (`session-picker.tsx` 의 `fixedSessionId`).
 * 예전에는 이 지름길이 목록 칸까지 건너뛰어, 반복 회의에 권하는 바로 그 길로 올린
 * 녹음은 늘 목록이 비어 자동 분리를 건너뛰었다. 목록 칸에는 이 세션의 가장 최근
 * 목록을 채워 보여 주고, 사람이 고친 뒤에 올린다.
 */
export function SessionHeader({
  session,
  count,
  onRename,
  onDelete,
  onUploadHere,
  onReject,
  className,
}: {
  /** null 이면 "세션 없음" 묶음. 이름도 못 고치고 못 지운다. */
  session: SessionDTO | null;
  count: number;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onUploadHere: (files: File[], sessionId: string) => void;
  onReject: (message: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session?.name ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 한글을 조합하는 중인가. 이벤트가 값을 안 실어 주는 판을 위한 깃발. */
  const composing = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(session?.name ?? "");
  }, [session?.name, editing]);

  const commit = async () => {
    if (!session) return;
    const next = draft.trim();
    if (!next || next === session.name) {
      setEditing(false);
      setDraft(session.name);
      return;
    }
    setSaving(true);
    try {
      await onRename(session.id, next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 맥락이 찼나.
   *
   * 서버는 넘칠 것 같으면 **거절한다** — 잘라 보내면 에이전트가 못 본 대목을
   * "그런 얘기 없습니다" 라고 답하고, 없는 것과 안 보낸 것이 화면에서
   * 같아진다. 거절은 누른 뒤에야 보이므로, 누르기 전에 여기서 알린다.
   */
  const full = session?.contextFull ?? false;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-(--color-border-soft) pb-1.5">
        <Layers
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            session ? "text-(--color-accent)" : "text-(--color-fg-4)",
          )}
        />

        {editing && session ? (
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
              void commit();
            }}
            onKeyDown={(e) => {
              // 조합 중의 Enter 는 IME 의 것이다. 가로채면 마지막 음절이 날아간다.
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(session.name);
              }
            }}
            aria-label="세션 이름"
            className="w-[min(22rem,60vw)] rounded-md bg-(--color-bg-2) px-2.5 py-1 text-sm text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
          />
        ) : (
          <h2 className="min-w-0 truncate text-sm text-(--color-fg-2)">
            {session ? session.name : "세션 없음"}
          </h2>
        )}

        <span className="shrink-0 text-[11px] text-(--color-fg-4)">
          녹음 {count}
          {session && ` · ${formatRelativeTime(new Date(session.updatedAt).getTime())}`}
        </span>

        {editing && session ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void commit()}
              disabled={saving}
              className="grid h-6 w-6 place-items-center rounded-md text-(--color-accent-strong) transition hover:bg-(--color-surface-hi) disabled:opacity-40"
              aria-label="세션 이름 저장"
              title="저장"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setEditing(false);
                setDraft(session.name);
              }}
              className="grid h-6 w-6 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
              aria-label="취소"
              title="취소"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          session && (
            <span className="ml-auto flex items-center gap-1">
              <UploadButton
                onFiles={(files) => onUploadHere(files, session.id)}
                onReject={onReject}
                label="이 세션에 올리기"
                className="bg-(--color-surface) px-2.5 py-1 text-[11px] font-normal text-(--color-fg-3) ring-1 ring-(--color-border-soft) hover:bg-(--color-surface-2) hover:text-(--color-fg-2)"
                iconClassName="h-3 w-3"
              />
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="grid h-6 w-6 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
                aria-label="세션 이름 고치기"
                title="세션 이름 고치기"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => {
                  /*
                    **전사문은 남는다.** 그것을 묻는 말에 그대로 적는다 —
                    "지울까요?" 만 있으면 사람은 녹음까지 사라진다고 읽고,
                    그러면 이 단추를 영영 못 누른다. 실제로 사라지는 것은
                    세션이 들고 있던 맥락(그동안의 대화)뿐이다.
                  */
                  if (
                    !confirm(
                      `세션 "${session.name}" 을(를) 지웁니다.\n\n` +
                        `붙어 있던 녹음 ${count}건과 전사문은 그대로 남고 "세션 없음" 으로 갑니다.\n` +
                        `사라지는 것은 이 세션이 쌓아 둔 맥락(그동안의 대화·화자 이름 기억)입니다.\n\n` +
                        `진행할까요?`,
                    )
                  ) {
                    return;
                  }
                  void onDelete(session.id);
                }}
                className="grid h-6 w-6 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-danger)"
                aria-label="세션 지우기"
                title="세션 지우기 (전사문은 남습니다)"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          )
        )}
      </div>

      {full && session && (
        /*
          맥락이 찼다. 여기서 하는 일은 **알리는 것뿐**이다 — 새로 시작할지
          녹음을 옮길지는 되돌릴 수 없는 선택이라, 카드가 함께 보이는 이
          자리보다 그 녹음 안(전사문 화면의 세션 알약)에서 고르는 것이 맞다.
        */
        <p className="flex items-start gap-1.5 rounded-md bg-(--color-warn)/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed break-keep text-(--color-warn) ring-1 ring-(--color-warn)/25">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0">
            이 세션의 맥락이 상한({session.contextLimit.toLocaleString()}자)에 닿았습니다. 더
            다듬거나 물으면 거절됩니다 — 잘라 보내면 에이전트가 못 본 대목을 “없다” 고 답하기
            때문입니다. 전사문 화면의 세션 알약에서 <b className="font-medium">맥락을 새로
            시작</b>하거나 그 녹음을 새 세션으로 옮기세요.
          </span>
        </p>
      )}
    </div>
  );
}
