"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * 좌우 두 칸과, 그 사이를 끌어 폭을 바꾸는 칸막이.
 *
 * 논문을 읽는 화면에서 좋은 비율은 사람마다 다르다. 그림과 수식이 많은 논문은
 * 원문을 넓게 봐야 하고, 요약을 길게 적는 사람은 글 쪽이 넓어야 한다. 한 값으로
 * 정해 두면 절반은 늘 불편하다. 그래서 끌게 두고, 매번 다시 맞추지 않도록
 * 브라우저에 기억해 둔다.
 *
 * 기억하는 것은 픽셀이 아니라 **비율(0~1)** 이다. 노트북에서 맞춘 640px 은 큰
 * 화면에서 한 뼘이 된다 — 창 크기가 달라져도 뜻이 남는 것은 비율뿐이다.
 *
 * ## 좁은 화면에서는 칸막이가 사라진다
 *
 * xl 미만에서는 위아래로 쌓이고 비율은 아무 뜻이 없다. 그 갈림을 `matchMedia`
 * 로 하지 않은 것은 일부러다 — 서버는 창 크기를 모르므로 첫 그림은 늘 "좁은
 * 화면" 이 되고, 붙자마자 넓은 배치로 튄다. 대신 비율을 CSS 변수로 넘기고
 * 그 변수를 **xl 미디어 쿼리 안에서만** 읽는다. 넓은지 좁은지는 CSS 가 처음부터
 * 알고 있으니 자바스크립트가 알 필요가 없다.
 *
 * ## 끄는 동안 폭이 바뀌지만 창 크기는 그대로다
 *
 * 이 칸막이는 `window` 의 resize 를 **일으키지 않는다.** 자기 상자가 좁아진
 * 것을 알아야 하는 쪽(pdf.js 뷰어처럼)은 window 를 듣지 말고 `ResizeObserver`
 * 로 자기 요소를 봐야 한다. 그러지 않으면 칸막이를 끌 때마다 원문이 잘리거나
 * 여백이 남는다.
 *
 * ## 접기는 비율과 다른 일이다
 *
 * `collapsed` 는 비율을 건드리지 않는다. `ratio` 를 1 로 밀어 접는 길은 두 번
 * 막혀 있다 — `maxRatio` 클램프에 걸려 끝까지 가지도 못하고, 설령 갔더라도 그
 * 값이 저장되어 **사람이 맞춰 둔 폭을 덮어쓴다.** 접었다 펴면 예전 폭이 그대로
 * 돌아와야 한다.
 */
export function SplitPane({
  left,
  right,
  collapsed = false,
  storageKey,
  defaultRatio = 0.58,
  minRatio = 0.25,
  maxRatio = 0.8,
  stackFirst = "left",
  label = "칸 너비 조절",
  className,
  leftClassName,
  rightClassName,
}: {
  left: ReactNode;
  right: ReactNode;
  /**
   * 오른쪽 칸을 접었는가. 접으면 왼쪽이 화면을 다 쓴다.
   *
   * **오른쪽은 언마운트하지 않고 감춘다.** 접는 것은 "지금은 안 본다" 이지
   * "버린다" 가 아니다 — 답을 기다리던 대화, 적다 만 글이 접는 순간 사라지면
   * 접기가 위험한 단추가 된다. 다시 펴면 그 자리 그대로여야 한다.
   *
   * 접는 것은 **오른쪽뿐이다.** 왼쪽을 감추는 길은 일부러 두지 않았다 —
   * pdf.js 는 상자 폭 0 을 그대로 배율 계산에 넣어 음수 배율을 박아 버린다.
   * 원문을 접는 날이 오면 그때는 감추지 말고 언마운트해야 한다.
   */
  collapsed?: boolean;
  /** 비율을 기억할 localStorage 칸. 없으면 기억하지 않는다. */
  storageKey?: string;
  /** 기억된 값이 없을 때, 그리고 칸막이를 두 번 눌렀을 때 돌아갈 자리. */
  defaultRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  /** 위아래로 쌓일 때 어느 쪽이 위로 오는가. */
  stackFirst?: "left" | "right";
  label?: string;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(defaultRatio);
  const [dragging, setDragging] = useState(false);
  // 손을 놓는 순간의 값을 저장해야 하는데, 이벤트 처리기가 붙잡고 있는 state 는
  // 한 박자 늦을 수 있다. 방금 정한 값을 확실히 아는 자리를 따로 둔다.
  const ratioRef = useRef(defaultRatio);

  // 기억해 둔 비율은 **붙은 뒤에** 읽는다. 그릴 때 읽으면 서버가 그린 것과
  // 달라져 하이드레이션이 어긋난다 — localStorage 는 서버에 없다.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      const v = raw === null ? Number.NaN : Number(raw);
      if (!Number.isFinite(v)) return;
      const next = clamp(v, minRatio, maxRatio);
      ratioRef.current = next;
      setRatio(next);
    } catch {
      /* 사생활 보호 모드 등 — 기본 비율로 산다 */
    }
  }, [storageKey, minRatio, maxRatio]);

  const apply = useCallback(
    (next: number) => {
      const v = clamp(next, minRatio, maxRatio);
      ratioRef.current = v;
      setRatio(v);
    },
    [minRatio, maxRatio],
  );

  // 끄는 동안에는 쓰지 않는다. 손을 놓을 때 한 번만 적는다 — 픽셀마다 적으면
  // localStorage 는 동기라 끄는 손이 무거워진다.
  const remember = useCallback(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, ratioRef.current.toFixed(4));
    } catch {
      /* 못 적어도 이번 화면에서는 잘 돌아간다 */
    }
  }, [storageKey]);

  const dragTo = useCallback(
    (clientX: number) => {
      const box = hostRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      apply((clientX - box.left) / box.width);
    },
    [apply],
  );

  const stop = useCallback(() => {
    setDragging(false);
    remember();
  }, [remember]);

  return (
    <div
      ref={hostRef}
      // 비율은 여기서 CSS 로 건네고, 읽는 것은 아래 xl: 클래스뿐이다.
      style={{ "--split-l": String(ratio) } as CSSProperties}
      className={cn(
        "flex min-w-0 flex-col gap-5 xl:flex-row xl:gap-0",
        dragging && "select-none",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-col",
          // 접었을 때 basis 를 아예 안 내놓는다. 두 클래스를 함께 두고 뒤에
          // 오는 것이 이기기를 기대하면, 어느 쪽이 이길지가 클래스 병합기의
          // 규칙에 달린다 — 그건 여기서 정할 일이지 거기 맡길 일이 아니다.
          collapsed
            ? "xl:basis-full"
            : "xl:shrink-0 xl:grow-0 xl:basis-[calc(var(--split-l,0.58)*100%)]",
          leftClassName,
        )}
      >
        {left}
      </div>

      {/*
        칸막이. 잡는 자리는 손가락이 닿게 넉넉히 두고, 보이는 선은 얇게 둔다 —
        굵은 선이 늘 그어져 있으면 두 칸이 별개의 화면처럼 갈라져 보인다.

        접혔으면 아예 안 그린다. 나눌 것이 없는데 선이 남아 있으면 끌 수 있어
        보이고, 끌어도 아무 일이 안 일어난다. 칸막이는 상태를 안 들고 있어
        지웠다 되살려도 잃는 것이 없다 — 폭은 바깥의 `ratio` 가 들고 있다.
      */}
      {!collapsed && (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        tabIndex={0}
        title="끌어서 폭 조절 · 두 번 누르면 기본 폭"
        className="group hidden shrink-0 cursor-col-resize items-center justify-center px-1.5 outline-none xl:flex"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // 끌기 시작할 때 글자가 잡히는 것을 막는다.
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (dragging) dragTo(e.clientX);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          stop();
        }}
        onPointerCancel={stop}
        onDoubleClick={() => {
          apply(defaultRatio);
          remember();
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.08 : 0.02;
          if (e.key === "ArrowLeft") apply(ratioRef.current - step);
          else if (e.key === "ArrowRight") apply(ratioRef.current + step);
          else if (e.key === "Home") apply(minRatio);
          else if (e.key === "End") apply(maxRatio);
          else if (e.key === "Enter" || e.key === " ") apply(defaultRatio);
          else return;
          e.preventDefault();
          remember();
        }}
      >
        <span
          className={cn(
            "h-full w-[3px] rounded-full bg-(--color-border-soft) transition-colors",
            "group-hover:bg-(--color-accent)/70 group-focus-visible:bg-(--color-accent)",
            dragging && "bg-(--color-accent)",
          )}
        />
      </div>
      )}

      <div
        className={cn(
          // `hidden` 과 `flex` 를 함께 두지 않는다. 위 왼쪽 칸과 같은 이유다.
          collapsed ? "hidden" : "flex min-w-0 flex-1 flex-col",
          // 쌓였을 때 어느 쪽이 위로 오는지. 넓어지면 DOM 순서로 돌아간다.
          stackFirst === "right" && "order-first xl:order-none",
          rightClassName,
        )}
      >
        {right}
      </div>

      {dragging && (
        /*
          끄는 동안 화면 전체를 덮어 둔다.
          오른쪽 칸에는 iframe 이, 왼쪽에는 캔버스가 있다. 포인터를 붙잡아 두긴
          했지만 iframe 은 자기 안으로 들어온 포인터를 삼키는 일이 있어, 그 위를
          지나가는 순간 칸막이가 손을 놓고 폭이 그 자리에 얼어붙는다. 투명한
          덮개 한 장이면 그런 자리가 아예 없어진다.
        */
        <div className="fixed inset-0 z-[80] cursor-col-resize" />
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
