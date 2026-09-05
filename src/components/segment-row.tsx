"use client";

import { Check, Pencil, Undo2, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { SegmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { formatClock } from "./format";
import { SegmentFlagBadge, SegmentFlagNote, normalizeFlag } from "./segment-flag";
import { SpeakerTag, type SpeakerStyle } from "./speaker";

/**
 * 전사문 한 줄. VAD 가 자른 조각 하나다 (길어야 30초).
 *
 * ## 누르는 것 두 가지가 겹치지 않게
 *
 * 이 줄은 "누르면 그 시각을 재생" 이기도 하고 "고칠 수 있어야" 하기도 하다.
 * 한 동작에 둘을 얹으면 어느 쪽도 안 된다 — 그래서 **글자를 누르면 재생,
 * 오른쪽 연필을 누르면 편집**으로 갈랐다. 연필은 늘 자리에 있고 마우스를
 * 올리거나 키보드 초점이 오면 진해진다.
 *
 * 글자를 끌어 **고르고 있었으면 재생하지 않는다.** 인용하려고 문장을 긁는 것은
 * 자주 하는 일인데, 손을 떼는 순간 소리가 튀면 그때마다 놀란다.
 *
 * ## 낱말 시각은 어떻게 붙나
 *
 * 지금 물려 있는 모델이 주는 것은 **토큰**별 시각이다(0.08초 눈금, ±0.3초).
 * 낱말은 이미 서버에서 묶어 `words: [{w, t}]` 로 온다.
 *
 * **모든 모델이 시각을 주는 것은 아니다.** sherpa-onnx 의 whisper 갈래는
 * `timestamps: []` 를 준다(실측). 그때는 모델 서술자의 `timestamps.kind` 가
 * `"none"` 이 되고, 위쪽이 `wordClick={false}` 를 내려보낸다 — 낱말 클릭을
 * 접고 **줄 클릭만** 남긴다. 갈 데가 없는데 낱말마다 손가락 모양이 뜨면,
 * 눌러 보고 아무 일도 안 일어나는 것을 몇 번 겪은 뒤에야 안 된다는 것을 안다.
 *
 * 그런데 화면에 그리는 글(`text`)은 에이전트가 다듬었거나 사람이 고친 것이라
 * 낱말 수가 `words` 와 다를 수 있다. 그때는 **순서 비율로 맞춘다** — 보이는
 * 열 번째 낱말이면 `words` 의 열 번째 언저리를 집는다. 정확히 그 낱말은 아닐
 * 수 있지만 **같은 조각 안**임은 보장된다(길어야 30초). 아무 데도 못 가는
 * 것보다 낫고, 줄 단위 클릭(±25ms)은 어차피 늘 정확하다.
 *
 * 낱말 수가 같으면 비율이 곧 1:1 이라 자동으로 정확해진다 — 다듬기가 문장
 * 부호와 대소문자만 손댄 흔한 경우가 여기 든다.
 */

interface Word {
  w: string;
  /** 전체 기준 초. */
  t: number;
}

/**
 * 보이는 글을 낱말로 쪼개고 각 낱말에 시각을 붙인다.
 *
 * 공백은 버리고 하나로 정규화한다. 전사문 한 줄에 들여쓰기나 빈 줄이 뜻을
 * 가지는 일은 없고, 남겨 두면 낱말 세기가 어긋난다.
 */
function alignWords(text: string, words: Word[], start: number): Word[] {
  const shown = text.match(/\S+/g) ?? [];
  if (shown.length === 0) return [];
  if (words.length === 0) {
    // 시각을 모르면 줄 시작으로 통일한다. 낱말을 눌러도 줄 머리로 간다 —
    // 아무 반응이 없는 것보다는 낫고, 거짓 시각을 지어내지도 않는다.
    return shown.map((w) => ({ w, t: start }));
  }
  if (shown.length === words.length) {
    return shown.map((w, i) => ({ w, t: words[i].t }));
  }
  const ratio = words.length / shown.length;
  return shown.map((w, i) => ({
    w,
    t: words[Math.min(words.length - 1, Math.floor(i * ratio))].t,
  }));
}

export interface SegmentRowProps {
  segment: SegmentDTO;
  speaker: SpeakerStyle | null;
  /** 지금 재생 중인 줄인가. */
  active: boolean;
  /**
   * 지금 재생 위치(초). **재생 중인 줄에만 넘어온다.**
   *
   * 모든 줄에 넘기면 200줄이 초당 몇 번씩 다시 그려진다. 아닌 줄에는 `null`
   * 이라는 **변하지 않는 값**이 가므로 `memo` 가 그 줄들을 통째로 건너뛴다.
   */
  time: number | null;
  /** 화자 이름 자동완성 목록의 id. */
  speakerListId: string;
  /** 낱말을 눌러 그 시각으로 갈 수 있나. 모델 서술자에서 온다. */
  wordClick: boolean;
  onSeek: (t: number) => void;
  onSave: (id: string, patch: { text?: string; speaker?: string | null }) => Promise<void>;
}

export const SegmentRow = memo(function SegmentRow({
  segment,
  speaker,
  active,
  time,
  speakerListId,
  wordClick,
  onSeek,
  onSave,
}: SegmentRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const [draftSpeaker, setDraftSpeaker] = useState(segment.speaker ?? "");
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  /** Esc 로 접었나. 접을 때 나는 blur 가 저장으로 새지 않게 하는 문지기. */
  const cancelled = useRef(false);

  const flag = useMemo(() => normalizeFlag(segment), [segment]);

  const words = useMemo(
    () => (wordClick ? alignWords(segment.text, segment.words, segment.start) : []),
    [wordClick, segment.text, segment.words, segment.start],
  );

  /** 지금 읽고 있는 낱말. 재생 중인 줄에서만 센다. */
  const activeWord = useMemo(() => {
    if (time === null || words.length === 0) return -1;
    let hit = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].t <= time + 0.05) hit = i;
      else break;
    }
    return hit;
  }, [time, words]);

  useEffect(() => {
    if (editing) {
      setDraft(segment.text);
      setDraftSpeaker(segment.speaker ?? "");
      // 끝에 커서를 둔다. 전부 고르면 한 글자만 고치려던 사람이 다 날린다.
      const el = textRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    // 편집을 시작하는 순간의 값만 담는다. 편집 중에 바깥 값이 바뀌어도
    // 적던 글을 덮지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = async () => {
    if (cancelled.current) return;
    const nextText = draft.trim();
    const nextSpeaker = draftSpeaker.trim();
    const patch: { text?: string; speaker?: string | null } = {};
    if (nextText !== segment.text) patch.text = nextText;
    if (nextSpeaker !== (segment.speaker ?? "")) patch.speaker = nextSpeaker || null;

    setEditing(false);
    // 바뀐 것이 없으면 서버를 부르지 않는다. 부르면 `edited` 가 켜져서 다음
    // 다듬기가 이 줄을 건너뛴다 — 아무것도 안 고쳤는데 손댄 줄이 되어 버린다.
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    try {
      await onSave(segment.id, patch);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    setEditing(false);
    setDraft(segment.text);
    setDraftSpeaker(segment.speaker ?? "");
    // 다음 편집을 막지 않도록 곧바로 푼다.
    setTimeout(() => {
      cancelled.current = false;
    }, 0);
  };

  const rail = speaker
    ? {
        borderLeftColor: speaker.color,
        borderLeftStyle: speaker.lineStyle,
        borderLeftWidth: speaker.lineWidth,
      }
    : { borderLeftColor: "var(--color-border-soft)", borderLeftStyle: "solid" as const, borderLeftWidth: 3 };

  return (
    <div
      id={`seg-${segment.id}`}
      data-segment-row
      {...(flag ? { "data-flagged": "" } : {})}
      style={rail}
      className={cn(
        "group flex scroll-mt-4 gap-3 py-2 pr-2 pl-3 transition-colors",
        // 재생 중인 줄은 **바탕색으로** 표시한다. 왼쪽 선은 화자의 것이라
        // 여기 쓸 수 없다 — 두 가지 뜻을 한 자리에 얹으면 둘 다 안 읽힌다.
        active ? "bg-(--color-accent-soft)" : "hover:bg-(--color-surface-2)/60",
      )}
    >
      {/* 시각. 줄 단위 클릭은 ±25ms 라 여기가 가장 정확한 손잡이다. */}
      <button
        type="button"
        onClick={() => onSeek(segment.start)}
        title={`${formatClock(segment.start)} 부터 재생`}
        className={cn(
          "mt-0.5 h-fit shrink-0 rounded font-mono text-[11px] tabular-nums transition",
          active
            ? "font-semibold text-(--color-accent-strong)"
            : "text-(--color-fg-4) hover:text-(--color-accent-strong)",
        )}
      >
        {/* 재생 중인 줄에는 삼각형이 하나 더 붙는다. 색을 못 봐도 갈린다. */}
        {active && <span aria-hidden>▸ </span>}
        {formatClock(segment.start)}
      </button>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {segment.speaker && speaker && <SpeakerTag name={segment.speaker} style={speaker} />}
          {segment.edited && (
            /*
              사람이 고친 줄이라는 표시.

              장식이 아니다 — 이 표시가 붙은 줄은 **다시 다듬어도 안 덮인다**
              (계약의 `edited`). 그 규칙이 화면에 안 보이면, 다듬기를 다시
              돌렸는데 이 줄만 그대로인 것이 고장으로 보인다.
            */
            <span
              className="inline-flex items-center gap-1 rounded-full bg-(--color-bg-2) px-1.5 py-0.5 text-[10px] text-(--color-fg-3) ring-1 ring-(--color-border-soft)"
              title="직접 고친 줄입니다. 다시 다듬어도 이 줄은 그대로 둡니다."
            >
              <Pencil className="h-2.5 w-2.5" />
              고침
            </span>
          )}
          {flag && (
            /*
              에이전트가 다듬지 않고 **표시만** 한 줄이다.

              이 모델은 못 알아듣는 소리에 빈 글이 아니라 그럴듯한 영어를
              지어낸다. 그것을 매끄럽게 다듬어 버리면 지어낸 글이 사실처럼
              남는다. 그래서 다듬는 대신 표시하게 시켰고, 그 표시가 여기 선다 —
              화면에 안 나오면 시킨 보람이 없다.
            */
            <SegmentFlagBadge flag={flag} />
          )}
        </div>

        {editing ? (
          <div
            className="flex flex-col gap-2"
            /*
              편집 칸 전체에서 초점이 빠져나가면 저장한다.
              단추들도 이 상자 안에 있으므로 "저장"·"취소"·"날 것 넣기" 를
              누르는 것은 여기 걸리지 않는다 — 그것들이 초점을 가져가도
              `relatedTarget` 이 여전히 이 안이다.
            */
            onBlur={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              void commit();
            }}
          >
            <input
              value={draftSpeaker}
              list={speakerListId}
              placeholder="화자 (비워 두면 없음)"
              onChange={(e) => setDraftSpeaker(e.target.value)}
              className="w-full max-w-[16rem] rounded-md bg-(--color-bg-2) px-2.5 py-1.5 text-[12px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
              aria-label="화자 이름"
            />
            <textarea
              ref={textRef}
              value={draft}
              rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 60)))}
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
              onKeyDown={(e) => {
                /*
                 * 조합 중의 Enter 는 **IME 의 것이다.** 여기서 가로채면
                 * 글자를 확정하려던 것이 저장이 되고 마지막 음절이 날아간다.
                 * 형제 앱들과 같은 세 신호를 함께 본다 — 이벤트 값, 옛 신호인
                 * keyCode 229, 그리고 깃발.
                 */
                if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
              className="scrollbar-thin w-full resize-y rounded-md bg-(--color-bg-2) px-2.5 py-2 text-[13px] leading-relaxed text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
              aria-label="이 줄의 글"
            />

            <div className="flex flex-wrap items-center gap-1.5">
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
                onClick={cancel}
                className="flex items-center gap-1 rounded-full bg-(--color-bg-2) px-3 py-1 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
              >
                <X className="h-3 w-3" />
                취소
              </button>
              {segment.raw.trim() !== draft.trim() && (
                /*
                  다듬기 전의 날 것으로 되돌리는 자리.

                  누른다고 곧바로 저장하지 않는다 — 상자에 넣어 주기만 한다.
                  되돌려 놓고 보니 다듬은 쪽이 나았을 수도 있고, 그때 "취소" 가
                  살아 있어야 한다.
                */
                <button
                  type="button"
                  onClick={() => setDraft(segment.raw)}
                  title="에이전트가 다듬기 전, 모델이 옮긴 그대로"
                  className="flex items-center gap-1 rounded-full bg-(--color-bg-2) px-3 py-1 text-[11px] text-(--color-fg-3) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
                >
                  <Undo2 className="h-3 w-3" />
                  날 것 넣기
                </button>
              )}
              <span className="text-[10.5px] text-(--color-fg-4)">
                Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소
              </span>
            </div>
          </div>
        ) : (
          <p
            /*
              낱말 클릭은 **위임으로** 받는다. 한 시간짜리 전사문이면 낱말이
              만 개인데, 낱말마다 처리기를 달면 그만큼의 함수가 메모리에 남고
              다시 그릴 때마다 새로 붙는다. 여기 하나만 두고 눌린 자리에서
              `data-t` 를 거슬러 올라가 찾는다.

              모델이 시각을 안 주면(`wordClick === false`) `data-t` 가 아예
              없다. 그때는 **줄 머리로** 보낸다 — 이 줄을 누른 사람이 원한
              것은 "여기부터 듣기" 이고, 그건 시각 단추와 같은 뜻이다.
            */
            onClick={(e) => {
              // 글자를 끌어 고르고 있었으면 재생하지 않는다.
              const sel = typeof window !== "undefined" ? window.getSelection() : null;
              if (sel && !sel.isCollapsed) return;
              if (!wordClick) {
                onSeek(segment.start);
                return;
              }
              const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-t]");
              if (!hit) return;
              const t = Number(hit.dataset.t);
              if (Number.isFinite(t)) onSeek(t);
            }}
            title={wordClick ? undefined : `${formatClock(segment.start)} 부터 재생`}
            className={cn(
              "text-[13.5px] leading-relaxed break-keep text-(--color-fg-2) [overflow-wrap:anywhere]",
              !wordClick && segment.text.trim() && "cursor-pointer",
            )}
          >
            {!segment.text.trim() ? (
              /*
                이 조각에서 옮겨진 말이 없다. 빈 줄로 두면 화면에서 사라져
                "왜 12:30 다음이 12:52 지" 가 된다. 자리를 남기고 이유를 남긴다.
              */
              <span className="text-[12px] text-(--color-fg-4)">(옮겨진 말 없음)</span>
            ) : !wordClick ? (
              /*
                시각을 낱말 단위로 못 받는 모델. 낱말을 감싸지 않고 통글자로
                그린다 — 감싸 두면 손가락 모양과 hover 가 "여기를 누르면 그
                낱말로 간다" 고 약속하는데, 갈 데가 없다.
              */
              segment.text
            ) : (
              words.map((w, i) => (
                <span key={i}>
                  <span
                    data-t={w.t}
                    className={cn(
                      "cursor-pointer rounded-[3px] px-px transition-colors hover:bg-(--color-surface-hi)",
                      // 읽고 있는 낱말은 바탕 + 밑줄 둘 다로 표시한다.
                      // 밑줄이 있어 색을 못 봐도 어디를 읽는지 보인다.
                      i === activeWord &&
                        "bg-(--color-accent)/25 underline decoration-(--color-accent-strong) decoration-2 underline-offset-2",
                    )}
                  >
                    {w.w}
                  </span>
                  {i < words.length - 1 ? " " : ""}
                </span>
              ))
            )}
          </p>
        )}

        {/* 표시된 줄에는 왜 표시됐는지와 다음에 할 일을 한 줄로 덧붙인다. */}
        {!editing && flag && <SegmentFlagNote flag={flag} />}
      </div>

      {!editing && (
        /*
          고치기 손잡이.

          흐리게 두되 **사라지지는 않는다.** 완전히 감추면 손가락으로 쓰는
          기기에서는 hover 가 없어 영영 못 찾는다.
        */
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="이 줄 고치기"
          title="이 줄 고치기"
          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-(--color-fg-4) opacity-30 transition group-hover:opacity-100 focus-visible:opacity-100 hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});
