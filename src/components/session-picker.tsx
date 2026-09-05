"use client";

import { FolderPlus, Layers, Search, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { SessionDTO } from "@/lib/types";
import { cn, formatRelativeTime } from "@/lib/utils";

import { formatBytes } from "./format";
import { titleFromFilename } from "./upload-queue";

/**
 * **올린 파일을 어느 세션에 넣을까.**
 *
 * 파일을 고르거나 끌어다 놓은 뒤, 전송이 시작되기 **전에** 한 번 묻는다.
 * 나중에 붙이면 안 된다 — 올라가자마자 전사가 돌고, 전사가 끝나면 다듬기가
 * 돈다. 그때 세션이 안 정해져 있으면 첫 다듬기가 이미 엉뚱한 자리에서 돈 뒤다.
 *
 * ## 왜 한 번만 묻나 (파일마다가 아니라)
 *
 * 한꺼번에 놓은 파일 묶음은 거의 언제나 **한 자리의 것**이다 — 같은 회의의
 * 1부·2부, 같은 날 찍은 인터뷰 둘. 여덟 개를 놓았다고 여덟 번 물으면 그
 * 여덟 번이 다 같은 답이다. 정말 갈라야 하면 올린 뒤에 카드에서 옮기면
 * 된다(`api.assign`) — 잘못 묶는 값이 옮기기 한 번인데, 매번 묻는 값은
 * 파일 하나당 한 번씩이다.
 *
 * ## 기본값을 **새 세션**으로 둔 이유
 *
 * 가장 최근 세션을 기본값으로 두면 손이 빠르다. 그런데 그 빠름의 대가가
 * **지난 회차의 맥락이 엉뚱한 회의에 섞이는 것**이다 — 화자 이름이 옮겨
 * 붙고, 지난주의 용어로 이번 녹음이 고쳐진다. 그건 눈에 잘 안 띄는 오염이라
 * 알아채는 데 오래 걸린다.
 *
 * 새 세션은 아무것도 안 섞는다. 잘못 골라도 잃는 것이 없다 —
 * "이어 붙이기" 를 놓쳤을 뿐이고, 그건 나중에 옮겨서 되찾을 수 있다.
 * 그래서 **되돌릴 수 있는 쪽**을 기본값으로 둔다.
 *
 * 대신 이어 붙이는 길을 가깝게 만든다: 기존 세션은 최근 순으로 위에 있고,
 * 목록 화면의 세션 머리말에는 "이 세션에 올리기" 가 따로 있어 여기까지
 * 오지 않아도 된다.
 */

export type UploadTarget = { kind: "new"; name: string } | { kind: "existing"; id: string };

/** 검색칸이 필요해지는 개수. 이보다 적으면 그냥 다 보인다. */
const SEARCH_AT = 8;

/** 검색 없이 한 번에 보여 주는 개수. */
const SHOWN = 6;

export function SessionPicker({
  files,
  sessions,
  notice,
  onCancel,
  onConfirm,
  className,
}: {
  files: File[];
  sessions: SessionDTO[];
  /**
   * 모델 안내(무엇을 알아듣는가). **이 상자 안에 들어와야 한다.**
   *
   * 이 상자가 뜨는 동안 아래의 올리는 칸은 사라진다 — 올리기가 두 군데면
   * 물음에 답하지 않고 다시 파일을 고르는 길이 생겨서다. 그런데 그 칸에
   * 붙어 있던 것이 "이 모델은 한국어를 못 합니다" 다. 같이 사라지면 **가장
   * 필요한 순간에** 없어진다 — 지금이 올리기 직전이다.
   */
  notice?: React.ReactNode;
  onCancel: () => void;
  onConfirm: (target: UploadTarget) => void;
  className?: string;
}) {
  /*
   * 기본 이름은 첫 파일 이름에서 확장자를 뗀 것.
   *
   * 빈 칸으로 두면 사람이 무엇을 적어야 할지 몰라 아무거나 적거나, 적기
   * 싫어서 기존 세션 아무 데나 던진다 — 그게 이 화면이 막으려는 바로 그 일이다.
   */
  const [name, setName] = useState(() => titleFromFilename(files[0]?.name ?? "새 세션"));
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const composing = useRef(false);

  const totalSize = files.reduce((s, f) => s + f.size, 0);

  /** 최근에 쓴 세션이 위로. 주간 회의는 거의 언제나 맨 위에 있다. */
  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [sessions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered.slice(0, SHOWN);
    return ordered.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 20);
  }, [ordered, query]);

  const canConfirm = pickedId !== null || name.trim().length > 0;

  const confirm = () => {
    if (pickedId !== null) {
      onConfirm({ kind: "existing", id: pickedId });
      return;
    }
    const next = name.trim();
    if (!next) return;
    onConfirm({ kind: "new", name: next });
  };

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-card)] bg-(--color-surface) p-5 ring-1 ring-(--color-accent)/35",
        className,
      )}
      // Esc 로 물릴 수 있어야 한다. 파일을 잘못 놓았을 때 빠져나갈 길이다.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-(--color-accent)" />
          <div className="min-w-0">
            <h2 className="text-sm text-(--color-fg)">이 파일들을 어느 세션에 넣을까요</h2>
            <p className="text-[11px] break-keep text-(--color-fg-4)">
              {files.length}개 · {formatBytes(totalSize)} — 같은 세션에 넣으면 다듬기·대화·요약이
              지난 녹음의 화자 이름과 용어를 물려받습니다.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
          aria-label="올리지 않기"
          title="올리지 않기"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* 무엇을 올리려는지 보인다. 잘못 놓았을 때 여기서 알아챈다. */}
      <ul className="flex flex-wrap gap-1.5">
        {files.slice(0, 6).map((f, i) => (
          <li
            key={`${f.name}-${i}`}
            className="max-w-[18rem] truncate rounded-full bg-(--color-bg-2) px-2.5 py-0.5 text-[10.5px] text-(--color-fg-3)"
            title={f.name}
          >
            {f.name}
          </li>
        ))}
        {files.length > 6 && (
          <li className="rounded-full bg-(--color-bg-2) px-2.5 py-0.5 text-[10.5px] text-(--color-fg-4)">
            외 {files.length - 6}개
          </li>
        )}
      </ul>

      <div className="flex flex-col gap-2">
        {/* ── 새 세션 (기본값) ───────────────────────────── */}
        <label
          className={cn(
            "flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 ring-1 transition",
            pickedId === null
              ? "bg-(--color-accent-soft) ring-(--color-accent)/40"
              : "bg-(--color-bg-2) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
          )}
        >
          <input
            type="radio"
            name="voice-session-target"
            checked={pickedId === null}
            onChange={() => setPickedId(null)}
            className="mt-1 accent-(--color-accent)"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[12.5px] text-(--color-fg-2)">
              <FolderPlus className="h-3.5 w-3.5 shrink-0 text-(--color-accent-strong)" />새 세션으로
            </span>
            <input
              value={name}
              onChange={(e) => {
                const c = (e.nativeEvent as InputEvent).isComposing;
                if (typeof c === "boolean") composing.current = c;
                setName(e.target.value);
                setPickedId(null);
              }}
              onFocus={() => setPickedId(null)}
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
                 * 키인데 여기서 가로채면 "주간 회의" 가 "주간 회" 로 저장되고,
                 * 더 나쁘게는 그 이름으로 전송이 시작된다.
                 */
                if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirm();
                }
              }}
              placeholder="세션 이름 (예: 제품팀 주간 회의)"
              aria-label="새 세션 이름"
              className="mt-1.5 w-full rounded-md bg-(--color-surface) px-2.5 py-1.5 text-[12px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
            />
          </span>
        </label>

        {/* ── 기존 세션에 이어 붙이기 ─────────────────────── */}
        {ordered.length === 0 ? (
          /*
            아직 세션이 하나도 없다. 고를 것이 없으니 목록도 안 그린다 —
            빈 목록을 보여 주면 "고를 수 있는데 아무것도 없다" 처럼 읽힌다.
          */
          <p className="px-1 text-[11px] break-keep text-(--color-fg-4)">
            아직 세션이 없습니다. 첫 세션이 여기서 만들어지고, 다음에 올릴 때부터 이어 붙일 수
            있습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-[11px] text-(--color-fg-4)">기존 세션에 이어 붙이기</span>
              {ordered.length > SEARCH_AT && (
                <span className="flex items-center gap-1 rounded-md bg-(--color-bg-2) px-2 py-1 ring-1 ring-(--color-border-soft)">
                  <Search className="h-3 w-3 shrink-0 text-(--color-fg-4)" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`세션 ${ordered.length}개에서 찾기`}
                    aria-label="세션 찾기"
                    className="w-[10rem] bg-transparent text-[11px] text-(--color-fg-2) outline-none placeholder:text-(--color-fg-4)"
                  />
                </span>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-(--color-fg-4)">찾는 세션이 없습니다</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {filtered.map((s) => (
                  <li key={s.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 transition",
                        pickedId === s.id
                          ? "bg-(--color-accent-soft) ring-(--color-accent)/40"
                          : "bg-(--color-bg-2) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
                      )}
                    >
                      <input
                        type="radio"
                        name="voice-session-target"
                        checked={pickedId === s.id}
                        onChange={() => setPickedId(s.id)}
                        className="accent-(--color-accent)"
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-(--color-fg-2)">
                        {s.name}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-(--color-fg-4)">
                        녹음 {s.recordingCount} ·{" "}
                        {formatRelativeTime(new Date(s.updatedAt).getTime())}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {!query && ordered.length > SHOWN && (
              <p className="px-1 text-[10.5px] text-(--color-fg-4)">
                최근 {SHOWN}개만 보입니다. 나머지는 위 칸에서 이름으로 찾으세요.
              </p>
            )}
          </div>
        )}
      </div>

      {notice}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[10.5px] break-keep text-(--color-fg-4)">
          {/*
            잘못 골라도 되돌릴 수 있다는 것을 여기서 말해 둔다. 이 말이 없으면
            사람이 고르기를 무서워해서, 무서운 나머지 아무것도 안 고르거나
            매번 새 세션만 만든다.
          */}
          올린 뒤에도 카드에서 다른 세션으로 옮길 수 있습니다.
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full bg-(--color-bg-2) px-3.5 py-1.5 text-xs text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
        >
          올리지 않기
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!canConfirm}
          className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-medium text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          올리기 시작
        </button>
      </div>
    </section>
  );
}
