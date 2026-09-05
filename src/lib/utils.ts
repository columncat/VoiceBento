import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(date: Date | number): string {
  const ts = typeof date === "number" ? date : date.getTime();
  if (!ts) return "";
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);

  if (s < 60) return "방금";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;

  const dt = new Date(ts);
  const yyyy = dt.getFullYear();
  const now = new Date();
  const sameYear = yyyy === now.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return sameYear ? `${mm}.${dd}` : `${yyyy}.${mm}.${dd}`;
}

export function formatDateTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
