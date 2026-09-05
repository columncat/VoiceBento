"use client";

import { AlertCircle, CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { formatBytes } from "./format";
import {
  cancelUpload,
  clearFinishedUploads,
  subscribeUploads,
  type UploadItem,
} from "./upload-queue";

/**
 * 올리는 줄을 보여 주는 칸.
 *
 * 이 앱에서 올리는 것은 한 시간짜리 영상 같은 것이다 — 1GB 를 넘고 몇십 분이
 * 걸린다. 그동안 아무 표시가 없으면 사람은 창을 닫고, 닫으면 조각 전송이
 * 끊긴다. 그래서 진행률·남은 시간·취소가 늘 보이는 자리에 있어야 한다.
 *
 * 화면 오른쪽 아래에 띄운다. 목록 위에 얹으면 카드를 가리고, 머리말에 넣으면
 * 스크롤을 내리는 순간 사라진다.
 */

const BUSY: UploadItem["status"][] = ["queued", "preparing", "uploading", "registering"];

const STATUS_TEXT: Record<UploadItem["status"], string> = {
  queued: "차례 기다리는 중",
  preparing: "자리 잡는 중",
  uploading: "",
  registering: "등록하는 중 — 곧 전사가 시작됩니다",
  done: "올렸습니다 — 전사 차례로 들어갔습니다",
  error: "",
  canceled: "취소됨",
};

/** 머리말 단추에 띄울 요약 — 진행 중 건수. */
export function useUploadSummary() {
  const [items, setItems] = useState<UploadItem[]>([]);
  useEffect(() => subscribeUploads(setItems), []);
  const active = items.filter((i) => BUSY.includes(i.status));
  return { total: items.length, active: active.length };
}

export function UploadPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  useEffect(() => subscribeUploads(setItems), []);

  if (!open) return null;

  const active = items.filter((i) => BUSY.includes(i.status));
  const totalSize = active.reduce((s, i) => s + i.size, 0);
  const totalSent = active.reduce((s, i) => s + i.sent, 0);

  return (
    <div className="fixed right-6 bottom-6 z-50 w-[min(400px,92vw)] rounded-[var(--radius-app)] bg-(--color-surface) shadow-2xl ring-1 ring-(--color-border)">
      <header className="flex items-center justify-between gap-2 border-b border-(--color-border-soft) px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Upload className="h-3.5 w-3.5 shrink-0 text-(--color-accent)" />
          <span className="truncate text-xs font-medium text-(--color-fg-2)">
            {active.length > 0
              ? `올리는 중 ${active.length}건 · ${formatBytes(totalSent)} / ${formatBytes(totalSize)}`
              : "올리기 완료"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={clearFinishedUploads}
            className="rounded-md px-2 py-1 text-[11px] text-(--color-fg-4) hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            title="끝난 항목 치우기"
          >
            치우기
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-(--color-fg-4) hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
            aria-label="닫기"
            title="닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs break-keep text-(--color-fg-4)">
          올리는 중인 항목이 없습니다
        </p>
      ) : (
        <ul className="scrollbar-thin max-h-[340px] divide-y divide-(--color-border-soft) overflow-y-auto">
          {items.map((i) => (
            <Row key={i.id} item={i} />
          ))}
        </ul>
      )}

      {active.length > 0 && (
        /*
          창을 닫으면 조각 전송이 끊긴다는 것을 미리 말해 둔다. 큰 파일에서는
          "다 됐겠지" 하고 탭을 닫는 일이 실제로 생기고, 그러면 수십 분이
          날아간다. 나중에 오류로 알려 주는 것보다 지금 한 줄이 낫다.
        */
        <p className="border-t border-(--color-border-soft) px-4 py-2 text-[10.5px] break-keep text-(--color-fg-4)">
          다 올라갈 때까지 이 탭을 열어 두세요. 닫으면 전송이 멈춥니다.
        </p>
      )}
    </div>
  );
}

/** 남은 시간 어림. 지금까지의 평균 속도로만 잰다 — 앞을 내다보는 척하지 않는다. */
function remainingText(item: UploadItem): string | null {
  if (item.status !== "uploading" || item.sent <= 0) return null;
  const elapsed = (Date.now() - item.startedAt) / 1000;
  if (elapsed < 3) return null;
  const speed = item.sent / elapsed;
  if (speed <= 0) return null;
  const left = (item.size - item.sent) / speed;
  if (left < 45) return "곧 끝납니다";
  const m = Math.round(left / 60);
  return m < 60 ? `약 ${m}분 남음` : `약 ${Math.floor(m / 60)}시간 ${m % 60}분 남음`;
}

function Row({ item }: { item: UploadItem }) {
  const pct = item.size > 0 ? Math.min(100, Math.round((item.sent / item.size) * 100)) : 0;
  const busy = BUSY.includes(item.status);
  const left = remainingText(item);

  return (
    <li className="flex items-start gap-2.5 px-4 py-2.5">
      <span className="mt-0.5 shrink-0">
        {item.status === "done" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-(--color-accent-strong)" />
        ) : item.status === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 text-(--color-danger)" />
        ) : item.status === "canceled" ? (
          <X className="h-3.5 w-3.5 text-(--color-fg-4)" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-(--color-fg-3)" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] text-(--color-fg-2)" title={item.name}>
          {item.name}
        </div>
        {busy && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-(--color-bg-2)">
            <div
              className="h-full rounded-full bg-(--color-accent) transition-[width]"
              style={{ width: `${item.status === "uploading" ? pct : 100}%` }}
            />
          </div>
        )}
        <div
          className={cn(
            "mt-0.5 truncate text-[10px]",
            item.status === "error" ? "text-(--color-danger)" : "text-(--color-fg-4)",
          )}
        >
          {item.status === "error" ? (
            item.error
          ) : item.status === "uploading" ? (
            <span className="font-mono">
              {formatBytes(item.sent)} / {formatBytes(item.size)}
              {left && ` · ${left}`}
            </span>
          ) : (
            STATUS_TEXT[item.status]
          )}
        </div>
      </div>

      {busy && (
        <button
          type="button"
          onClick={() => cancelUpload(item.id)}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-(--color-fg-4) hover:text-(--color-danger)"
          aria-label="취소"
          title="취소"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}
