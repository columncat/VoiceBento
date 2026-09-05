"use client";

import { FileVideo, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 소리·영상 파일을 끌어다 놓거나 골라 올리는 자리.
 *
 * 실제 전송은 `upload-queue.ts` 가 맡는다. 여기는 파일을 **받기만** 한다.
 *
 * ## 무엇을 받아 주는가
 *
 * 서버가 ffmpeg 로 16kHz 모노 WAV 로 맞추므로 컨테이너·코덱을 가릴 이유가
 * 거의 없다. 그래서 목록은 **넉넉하게** 두고, 확실히 아닌 것(사진·문서·압축
 * 파일)만 여기서 떨어뜨린다. 사진 폴더를 통째로 끌어다 놓았을 때 오류 40개가
 * 뜨는 것보다 조용히 걸러 내고 몇 개를 걸렀는지 한 줄로 알려 주는 편이 낫다.
 *
 * MIME 만 보고 거르지 않는다. `.mkv`·`.opus`·`.m4b` 는 브라우저·OS 조합에
 * 따라 빈 MIME 로 들어온다 — 그때 확장자가 유일한 단서다.
 */

/** `<input accept>` 에 들어가는 값. 고르기 창의 기본 필터일 뿐 강제는 아니다. */
const ACCEPT = "audio/*,video/*";

const MEDIA_EXTS = new Set([
  // 소리
  "mp3", "m4a", "m4b", "wav", "flac", "ogg", "oga", "opus", "aac", "wma", "aiff", "aif", "amr", "caf",
  // 영상 — 오디오 트랙만 뽑아 쓴다
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp",
]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isMedia(f: File): boolean {
  if (f.type.startsWith("audio/") || f.type.startsWith("video/")) return true;
  return MEDIA_EXTS.has(extOf(f.name));
}

/** 받아도 되는 것만 남긴다. 걸러진 개수를 함께 돌려준다. */
export function keepMedia(files: File[]): { kept: File[]; dropped: number } {
  const kept = files.filter(isMedia);
  return { kept, dropped: files.length - kept.length };
}

export function UploadDrop({
  onFiles,
  onReject,
  className,
  children,
  /** 안내문 없이 오버레이만. 화면 전체를 감쌀 때 쓴다. */
  bare = false,
}: {
  onFiles: (files: File[]) => void;
  onReject?: (message: string) => void;
  className?: string;
  children?: React.ReactNode;
  bare?: boolean;
}) {
  const [over, setOver] = useState(false);
  /*
   * dragenter/dragleave 는 자식 요소를 지날 때마다 짝지어 터진다. 참/거짓
   * 하나로 두면 목록 위를 지나는 동안 오버레이가 미친 듯이 깜빡인다.
   * 들어오고 나간 횟수를 세어 0 이 될 때만 끈다.
   */
  const depth = useRef(0);

  const take = (files: File[]) => {
    const { kept, dropped } = keepMedia(files);
    if (dropped > 0) {
      onReject?.(
        kept.length > 0
          ? `소리·영상이 아닌 파일 ${dropped}개는 건너뛰었습니다`
          : "소리나 영상 파일만 올릴 수 있습니다",
      );
    }
    if (kept.length > 0) onFiles(kept);
  };

  return (
    <div
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        // preventDefault 를 빼면 브라우저가 영상을 그냥 탭에서 재생해 버린다.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        take(Array.from(e.dataTransfer.files ?? []));
      }}
      className={cn("relative", className)}
    >
      {children}

      {!bare && !children && (
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-6 text-(--color-fg-4)">
          <Upload className="h-5 w-5" />
          <span className="text-[11.5px] break-keep">
            소리·영상 파일을 여기에 끌어다 놓으세요
          </span>
        </div>
      )}

      {over && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-[inherit] bg-(--color-accent-soft) ring-2 ring-(--color-accent)/60 ring-inset">
          <span className="flex items-center gap-2 rounded-full bg-(--color-surface) px-3 py-1.5 text-xs text-(--color-accent-strong) shadow-lg">
            <Upload className="h-3.5 w-3.5" />
            여기에 놓기
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 파일 고르기 단추.
 *
 * 끌어다 놓기가 어려운 기기(터치)에서는 이쪽이 유일한 길이다. 그래서 아이콘만
 * 두지 않고 글자를 함께 둔다 — 이 앱에서 파일을 올리는 것은 곁다리가 아니라
 * 첫 번째로 하는 일이다.
 */
export function UploadButton({
  onFiles,
  onReject,
  className,
  /** 아이콘 크기를 줄여 다는 자리가 있다 — 세션 머리말의 지름길 단추. */
  iconClassName,
  label = "파일 고르기",
}: {
  onFiles: (files: File[]) => void;
  onReject?: (message: string) => void;
  className?: string;
  iconClassName?: string;
  label?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          input.current?.click();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "flex items-center gap-2 rounded-full bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-bg) transition hover:bg-(--color-accent-strong)",
          className,
        )}
      >
        <FileVideo className={cn("h-4 w-4", iconClassName)} />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          // 같은 파일을 두 번 고를 수 있어야 한다. 값을 비우지 않으면
          // change 가 다시 터지지 않는다.
          e.target.value = "";
          const { kept, dropped } = keepMedia(picked);
          if (dropped > 0) onReject?.(`소리·영상이 아닌 파일 ${dropped}개는 건너뛰었습니다`);
          if (kept.length > 0) onFiles(kept);
        }}
      />
    </>
  );
}
