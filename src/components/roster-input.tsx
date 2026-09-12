"use client";

import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";

import { cleanName, nameKey } from "@/lib/name-key";
import { cn } from "@/lib/utils";

/**
 * 말한 사람 목록을 적는 칸 — 이름 알약 + 입력 한 줄.
 *
 * **두 자리에서 같은 것을 쓴다:** 화자 나누기 패널(`speaker-panel.tsx`)과
 * 올리기 직전의 세션 고르기(`session-picker.tsx`). 둘이 따로 입력 칸을 들면
 * 한쪽만 IME 처리나 중복 거르기를 고치는 날이 온다 — 그러면 올릴 때 적은
 * 목록과 나중에 고친 목록이 다른 규칙으로 들어간다.
 *
 * 서버의 울타리(`lib/roster-schema.ts`)와 같은 값을 여기서도 건다: 한 이름 40자,
 * 60명. 서버가 어차피 막지만, 올리기는 파일을 **다 보낸 뒤에** 목록을 확인하므로
 * 여기서 먼저 못 넘게 해야 몇 GB 를 보낸 뒤에 거절당하지 않는다.
 */

const MAX_NAME = 40;
const MAX_NAMES = 60;

export function RosterInput({
  value,
  onChange,
  placeholder = "이름을 적고 Enter (예: 지수)",
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [entry, setEntry] = useState("");
  const composing = useRef(false);

  const addName = (raw: string) => {
    // 보이지 않는 형식 문자(복사해 붙인 이름에 묻어 오는 U+200B 등)는 서버와 같이 뗀다 (`cleanName`).
    const name = cleanName(raw).slice(0, MAX_NAME);
    if (!nameKey(name)) return;
    /*
     * 같은 이름을 두 번 세면 `k` 가 하릴없이 커진다. **서버와 같은 열쇠로** 견준다
     * (`name-key.ts`) — 여기만 "글자가 똑같은가" 로 두면 "Kim" 옆에 "kim" 이 알약으로
     * 서는데 서버는 한 명으로 세서, 화면에 보이는 인원과 실제 k 가 어긋난다.
     */
    const key = nameKey(name);
    if (!value.some((n) => nameKey(n) === key)) onChange([...value, name].slice(0, MAX_NAMES));
    setEntry("");
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((name) => (
          <span
            key={name}
            className="flex items-center gap-1 rounded-full bg-(--color-bg-2) py-0.5 pr-1 pl-2.5 text-[11.5px] text-(--color-fg-2) ring-1 ring-(--color-border-soft)"
          >
            {name}
            <button
              type="button"
              onClick={() => onChange(value.filter((n) => n !== name))}
              aria-label={`${name} 빼기`}
              className="rounded-full p-0.5 text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && (
          <span className="text-[11px] text-(--color-fg-4)">아직 아무도 안 적었습니다</span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <input
          value={entry}
          onChange={(e) => {
            const c = (e.nativeEvent as InputEvent).isComposing;
            if (typeof c === "boolean") composing.current = c;
            setEntry(e.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onBlur={() => {
            composing.current = false;
            /*
             * 칸을 떠나면 적던 이름을 **목록에 넣는다.** Enter 를 안 누르고 곧바로
             * "올리기 시작" 이나 "화자 나누기" 를 누르는 일이 흔한데, 그때 적어 둔
             * 이름이 조용히 빠지면 k 가 하나 모자라게 돈다 — 한 명 빠뜨리는 쪽이
             * 한 명 더 적는 쪽보다 결과가 나쁘다.
             */
            if (entry.trim()) addName(entry);
          }}
          onKeyDown={(e) => {
            /*
             * 조합 중의 Enter 는 **IME 의 것이다.** 여기서 가로채면 "지수" 를
             * 적다가 마지막 음절이 날아간 채로 등록된다. 이 앱의 다른 입력 칸과
             * 같은 세 신호를 함께 본다.
             */
            if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addName(entry);
            }
          }}
          placeholder={placeholder}
          maxLength={MAX_NAME}
          className="min-w-0 flex-1 rounded-md bg-(--color-surface) px-2.5 py-1.5 text-[11.5px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
          aria-label="화자 이름 더하기"
        />
        <button
          type="button"
          // 누르는 순간 입력 칸의 blur 가 먼저 이름을 넣는다. 여기서 한 번 더 넣어도 중복은 걸러진다.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => addName(entry)}
          disabled={!entry.trim()}
          className="flex shrink-0 items-center gap-1 rounded-full bg-(--color-bg-2) px-2.5 py-1.5 text-[11px] text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          더하기
        </button>
      </div>
    </div>
  );
}
