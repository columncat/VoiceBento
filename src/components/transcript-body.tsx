"use client";

import { Crosshair } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { ModelNoticeDTO, RecordingNoticeDTO, SegmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { EmptyTranscriptNotice } from "./language-notice";
import { SegmentRow } from "./segment-row";
import { SpeakerLegend, useSpeakerStyles } from "./speaker";

/**
 * 전사문 본문. 화면 가운데를 차지하는 것.
 *
 * ## 재생 위치를 여기서 센다
 *
 * `currentTime` 을 위쪽(전사문 화면)에 두면 대화창과 요약창까지 초당 몇 번씩
 * 다시 그려진다. 그래서 시간은 **이 상자 안에만** 산다. 위로는 "재생 중인 줄이
 * 있는가" 라는 참/거짓 하나만 올려 보낸다 — 그건 몇 분에 한 번 바뀐다.
 *
 * 줄들은 `memo` 라 시간이 흘러도 다시 그려지지 않는다. 지금 재생 중인 줄
 * 하나에만 `time` 이 내려가고 나머지에는 `null` 이라는 안 변하는 값이 간다.
 *
 * `timeupdate` 대신 rAF 를 쓴다. `timeupdate` 는 브라우저마다 초당 4번 남짓이라
 * 낱말(0.3초 안팎)을 따라가기에 성기다. 다만 rAF 를 그대로 쓰면 초당 60번이라
 * 200ms 로 묶는다 — 낱말보다 촘촘할 이유가 없다.
 *
 * ## 따라가기는 켜 두되 손이 이기게 한다
 *
 * 기본은 켬이다. 소리를 들으며 글을 눈으로 좇는 것이 이 화면의 기본 쓰임이고,
 * 그때 손으로 따라 굴리게 하면 1분마다 스무 번을 굴려야 한다.
 *
 * 그런데 **읽던 자리에서 끌려 나가는 것**이 그보다 더 성가시다 — 앞에서 한
 * 말을 되짚어 보는 동안 화면이 재생 위치로 튀어 오르면 읽던 줄을 잃는다.
 * 그래서 사람이 스스로 굴리는 순간(휠·터치·키보드) 따라가기를 **끈다.** 끄면
 * 아래에 "재생 중인 줄 보기" 알약이 뜨고, 그걸 누르면 다시 켜진다.
 *
 * 스크롤 이벤트를 보고 판단하지 않는다. 그건 우리가 굴린 것과 사람이 굴린
 * 것을 구별하지 못해서, 따라가기가 자기 스크롤에 스스로 꺼진다. 휠·터치·키는
 * 사람만 일으키는 신호라 헷갈릴 여지가 없다.
 */

/** 재생 위치를 다시 재는 간격. 낱말이 0.3초 안팎이라 이보다 촘촘할 이유가 없다. */
const TICK_MS = 200;

/** 따라갈 때 재생 중인 줄을 상자의 어디쯤에 둘지. 위쪽 1/3 — 다음 줄이 함께 보인다. */
const FOLLOW_ANCHOR = 0.34;

export function TranscriptBody({
  segments,
  audioRef,
  following,
  onFollowingChange,
  onActiveChange,
  jumpRef,
  notice,
  model,
  showEmptyNotice,
  onSave,
  className,
}: {
  segments: SegmentDTO[];
  audioRef: RefObject<HTMLAudioElement | null>;
  following: boolean;
  onFollowingChange: (v: boolean) => void;
  /** 재생 중인 줄이 생겼는지/없어졌는지. 위쪽 재생기의 단추를 켜고 끈다. */
  onActiveChange: (has: boolean) => void;
  /** 위쪽 재생기의 "재생 중인 줄로" 가 부를 함수를 여기 꽂아 둔다. */
  jumpRef: RefObject<(() => void) | null>;
  notice: RecordingNoticeDTO | null;
  model: ModelNoticeDTO | null;
  /** 전사가 끝났는데 옮겨진 말이 거의 없는가. */
  showEmptyNotice: boolean;
  onSave: (id: string, patch: { text?: string; speaker?: string | null }) => Promise<void>;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [time, setTime] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeVisible, setActiveVisible] = useState(true);

  const speakers = useSpeakerStyles(segments);
  const speakerListId = "voice-speaker-names";

  /**
   * 조각 시작 시각만 뽑아 둔다. 이분 탐색에 쓴다.
   *
   * 한 시간짜리는 조각이 수백이고 이 함수가 초당 다섯 번 돈다. 훑어 내려가도
   * 못 버틸 정도는 아니지만, 정렬돼 있는 것을 훑을 이유는 없다.
   */
  const starts = useMemo(() => segments.map((s) => s.start), [segments]);

  const findIndex = useCallback(
    (t: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= t) {
          hit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      /*
       * 조각과 조각 사이(VAD 가 말이 없다고 본 구간)에 와 있으면 아무 줄도
       * 켜지 않는다. 직전 줄을 계속 켜 두면 소리는 이미 다음 이야기로
       * 넘어갔는데 화면은 몇십 초 전 줄을 가리키고 있게 된다.
       */
      if (hit >= 0 && t > segments[hit].end + 0.4) return -1;
      return hit;
    },
    [starts, segments],
  );

  /** 지금 재생 중인 줄을 상자 안으로 불러온다. */
  const jumpToActive = useCallback(() => {
    const box = boxRef.current;
    if (!box || activeIndex < 0) return;
    const row = box.querySelector<HTMLElement>("[data-active-row]");
    if (!row) return;
    /*
     * `scrollIntoView` 를 쓰지 않는다. 그 함수는 조상 상자까지 함께 굴려서
     * **페이지 전체가** 튄다 — 오른쪽 대화창을 보고 있었으면 그것도 끌려간다.
     * 우리가 굴리고 싶은 것은 이 상자 하나뿐이다.
     */
    box.scrollTo({
      top: Math.max(0, row.offsetTop - box.clientHeight * FOLLOW_ANCHOR),
      behavior: "smooth",
    });
  }, [activeIndex]);

  useEffect(() => {
    jumpRef.current = jumpToActive;
    return () => {
      jumpRef.current = null;
    };
  }, [jumpToActive, jumpRef]);

  // 재생 위치를 재는 고리. 소리가 없으면 아예 안 돈다.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    let raf = 0;
    let last = 0;
    let prevT = -1;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < TICK_MS) return;
      last = now;

      const t = el.currentTime;
      // 멈춰 있으면 아무것도 안 한다. 아래의 DOM 재기까지 초당 다섯 번씩
      // 돌 이유가 없다 — 멈춘 화면에서는 잴 것이 바뀌지 않는다.
      if (t === prevT) return;
      prevT = t;

      setTime(t);
      setActiveIndex((prev) => {
        const next = findIndex(t);
        return next === prev ? prev : next;
      });

      // 재생 중인 줄이 상자 안에 보이는가. 안 보일 때만 알약을 띄운다.
      const box = boxRef.current;
      if (box) {
        const row = box.querySelector<HTMLElement>("[data-active-row]");
        const visible =
          !row ||
          (row.offsetTop + row.offsetHeight > box.scrollTop &&
            row.offsetTop < box.scrollTop + box.clientHeight);
        setActiveVisible((v) => (v === visible ? v : visible));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioRef, findIndex]);

  useEffect(() => {
    onActiveChange(activeIndex >= 0);
  }, [activeIndex, onActiveChange]);

  // 줄이 바뀔 때만 따라간다. 같은 줄 안에서 낱말이 넘어갈 때마다 굴리면
  // 화면이 계속 미세하게 떨린다.
  useEffect(() => {
    if (!following || activeIndex < 0) return;
    jumpToActive();
  }, [following, activeIndex, jumpToActive]);

  /*
   * 사람이 스스로 굴리면 따라가기를 끈다.
   *
   * 휠·터치·스크롤 키만 본다. 셋 다 사람만 일으키는 신호다. `scroll` 이벤트를
   * 보면 우리가 방금 굴린 것까지 잡혀 따라가기가 스스로 꺼진다.
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !following) return;
    const off = () => onFollowingChange(false);
    const onKey = (e: KeyboardEvent) => {
      if (
        ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(e.key) &&
        // 글을 고치는 중이면 그 키는 글자 다루는 것이다. 따라가기와 상관없다.
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLInputElement)
      ) {
        off();
      }
    };
    box.addEventListener("wheel", off, { passive: true });
    box.addEventListener("touchmove", off, { passive: true });
    box.addEventListener("keydown", onKey);
    return () => {
      box.removeEventListener("wheel", off);
      box.removeEventListener("touchmove", off);
      box.removeEventListener("keydown", onKey);
    };
  }, [following, onFollowingChange]);

  const onSeek = useCallback(
    (t: number) => {
      const el = audioRef.current;
      if (!el) return;
      el.currentTime = t;
      /*
       * 누르면 **재생까지 한다.** 시각만 옮기고 멈춰 있으면 "눌렀는데 아무
       * 소리도 안 난다" 가 된다. 사람이 줄을 누르는 것은 거기를 들으려는
       * 것이지 재생 머리만 옮기려는 것이 아니다.
       *
       * 브라우저가 자동 재생을 막으면 `play()` 가 거절된다. 그때는 시각만
       * 옮겨진 채로 두고 넘어간다 — 사람이 재생을 한 번 누르면 거기서 시작한다.
       */
      void el.play().catch(() => undefined);
    },
    [audioRef],
  );

  if (showEmptyNotice) {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <EmptyTranscriptNotice notice={notice} model={model} />
        {/* 조각이 있긴 하면(빈 글이라도) 아래에 그대로 보여 준다. 시각은 맞으니까. */}
        {segments.length > 0 && (
          <p className="px-1 text-[11px] text-(--color-fg-4)">
            아래는 옮겨진 조각 {segments.length}개입니다. 대부분 비어 있습니다.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {speakers.size > 0 && (
        <SpeakerLegend
          styles={speakers}
          className="shrink-0 rounded-lg bg-(--color-bg-2) px-3 py-2 ring-1 ring-(--color-border-soft)"
        />
      )}

      {/*
        화자 이름 자동완성. 줄마다 목록을 하나씩 그리면 화자가 넷일 때
        200줄 × 4 개의 option 이 DOM 에 깔린다. 하나만 두고 다 같이 쓴다.
      */}
      <datalist id={speakerListId}>
        {[...speakers.keys()].map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="relative min-h-0 flex-1">
        <div
          ref={boxRef}
          // `tabIndex` 가 있어야 상자 자체가 키보드 초점을 받아 방향키로 굴릴 수
          // 있고, 그래야 위의 `keydown` 이 잡힌다.
          tabIndex={0}
          role="region"
          aria-label="전사문"
          /*
            `relative` 가 있어야 줄의 `offsetTop` 이 **이 상자 기준**이 된다.
            없으면 바깥 상자가 기준이 되어, 굴린 만큼 어긋난 값으로 굴리게 된다.
          */
          className="scrollbar-thin relative h-full divide-y divide-(--color-border-soft) overflow-y-auto rounded-[var(--radius-card)] bg-(--color-surface) py-1 ring-1 ring-(--color-border-soft) outline-none focus-visible:ring-(--color-accent)/40"
        >
          {segments.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-(--color-fg-4)">
              아직 옮겨진 글이 없습니다
            </p>
          ) : (
            segments.map((s, i) => (
              <div key={s.id} {...(i === activeIndex ? { "data-active-row": "" } : {})}>
                <SegmentRow
                  segment={s}
                  speaker={s.speaker ? (speakers.get(s.speaker.trim()) ?? null) : null}
                  active={i === activeIndex}
                  time={i === activeIndex ? time : null}
                  speakerListId={speakerListId}
                  onSeek={onSeek}
                  onSave={onSave}
                />
              </div>
            ))
          )}
        </div>

        {/*
          따라가기가 꺼졌고 재생 중인 줄이 화면 밖에 있을 때만 뜬다.
          늘 떠 있으면 글 위에 얹힌 짐이 되고, 없으면 재생 위치를 잃는다.
        */}
        {!following && activeIndex >= 0 && !activeVisible && (
          <button
            type="button"
            onClick={() => {
              jumpToActive();
              onFollowingChange(true);
            }}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-(--color-accent) px-3.5 py-1.5 text-[11.5px] font-medium text-(--color-bg) shadow-lg transition hover:bg-(--color-accent-strong)"
          >
            <Crosshair className="h-3.5 w-3.5" />
            재생 중인 줄 보기
          </button>
        )}
      </div>
    </div>
  );
}
