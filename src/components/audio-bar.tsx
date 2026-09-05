"use client";

import { AlertCircle, Crosshair, LocateFixed, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

import { cn } from "@/lib/utils";

/**
 * 재생기. 전사문 위에 하나만 있다.
 *
 * ## 브라우저 기본 재생기를 쓴다
 *
 * 재생·일시정지·탐색 막대·음량을 직접 그리지 않는다. 기본 재생기는 키보드로
 * 다 되고, 낭독기가 알아보고, 모바일에서 잠금화면 조작까지 붙는다. 그걸
 * 흉내 내서 만든 것은 거의 항상 그보다 못하다. 대신 **기본 재생기에 없거나
 * 숨어 있는 것**만 옆에 단다 — 배속(크롬은 넘침 메뉴 안, 파이어폭스는
 * 오른쪽 클릭이라 아무도 못 찾는다)과 5초 되감기, 그리고 따라가기.
 *
 * ## 5초 되감기가 왜 있나
 *
 * 전사문을 고칠 때 가장 자주 하는 일이 "방금 그거 뭐라고 했지" 다. 탐색
 * 막대를 잡아 끌면 몇 초를 정확히 되돌리기가 어렵다.
 */

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export function AudioBar({
  src,
  audioRef,
  following,
  onFollowingChange,
  onJumpToActive,
  hasActive,
  className,
}: {
  src: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** 재생 중인 줄을 화면이 따라가는가. */
  following: boolean;
  onFollowingChange: (v: boolean) => void;
  /** "재생 중인 줄로" — 지금 재생 중인 줄을 화면에 불러온다. */
  onJumpToActive: () => void;
  hasActive: boolean;
  className?: string;
}) {
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  // 배속은 요소의 속성이라 React 가 안 챙긴다. 바뀔 때마다 직접 얹는다.
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [rate, audioRef]);

  const nudge = (delta: number) => {
    const el = audioRef.current;
    if (!el) return;
    // `duration` 이 NaN 인 동안(메타데이터 전)에도 뒤로 감기는 되어야 한다.
    const max = Number.isFinite(el.duration) ? el.duration : Number.MAX_SAFE_INTEGER;
    el.currentTime = Math.min(max, Math.max(0, el.currentTime + delta));
  };

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-[var(--radius-app)] bg-(--color-surface) p-3 ring-1 ring-(--color-border-soft)",
        className,
      )}
    >
      {/*
        `preload="metadata"` — 길이와 탐색만 받아 두고 소리는 누를 때 받는다.
        한 시간짜리 오디오를 화면 열자마자 통째로 내려받으면 목록에서 들어올
        때마다 수백 MB 가 나간다.
      */}
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
        onLoadedMetadata={() => setFailed(false)}
        className="w-full"
      />

      {failed && (
        <p className="flex items-start gap-1.5 rounded-lg bg-(--color-danger)/10 px-2.5 py-1.5 text-[11px] break-keep text-(--color-danger) ring-1 ring-(--color-danger)/25">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {/*
            소리가 안 나는 것은 오류로 안 보인다 — 그래서 이 줄이 필요하다.
            원인은 대개 셋이다: 파일이 아직 안 올라갔다, 로그인이 풀렸다,
            브라우저가 이 코덱을 모른다(원본이 mkv 인 경우가 많다).
          */}
          <span>
            소리를 불러오지 못했습니다. 로그인이 풀렸거나, 브라우저가 이 파일의 코덱을 모르는
            경우입니다. 전사문 자체는 그대로 보고 고칠 수 있습니다.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => nudge(-5)}
            title="5초 뒤로"
            aria-label="5초 뒤로"
            className="flex items-center gap-1 rounded-full bg-(--color-bg-2) px-2.5 py-1 text-[11px] text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
          >
            <RotateCcw className="h-3 w-3" />5
          </button>
          <button
            type="button"
            onClick={() => nudge(5)}
            title="5초 앞으로"
            aria-label="5초 앞으로"
            className="flex items-center gap-1 rounded-full bg-(--color-bg-2) px-2.5 py-1 text-[11px] text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi)"
          >
            <RotateCw className="h-3 w-3" />5
          </button>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="재생 속도">
          <span className="text-[10.5px] text-(--color-fg-4)">속도</span>
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRate(r)}
              aria-pressed={rate === r}
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[11px] ring-1 transition",
                rate === r
                  ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40"
                  : "bg-(--color-bg-2) text-(--color-fg-3) ring-(--color-border-soft) hover:bg-(--color-surface-hi)",
              )}
            >
              {r}×
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onJumpToActive}
            disabled={!hasActive}
            title="지금 재생 중인 줄을 화면으로 불러옵니다"
            className="flex items-center gap-1.5 rounded-full bg-(--color-bg-2) px-3 py-1 text-[11px] text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-40"
          >
            <Crosshair className="h-3 w-3" />
            재생 중인 줄로
          </button>

          {/*
            따라가기.

            켜짐/꺼짐을 색으로만 가르지 않는다 — 글자("따라가기 켬"/"끔")와
            `aria-pressed` 가 함께 바뀐다.
          */}
          <button
            type="button"
            onClick={() => onFollowingChange(!following)}
            aria-pressed={following}
            title={
              following
                ? "재생을 따라 화면이 스크롤됩니다. 손으로 스크롤하면 저절로 꺼집니다"
                : "화면이 재생을 따라가지 않습니다"
            }
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] ring-1 transition",
              following
                ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40"
                : "bg-(--color-bg-2) text-(--color-fg-3) ring-(--color-border-soft) hover:bg-(--color-surface-hi)",
            )}
          >
            <LocateFixed className="h-3 w-3" />
            따라가기 {following ? "켬" : "끔"}
          </button>
        </div>
      </div>
    </section>
  );
}
