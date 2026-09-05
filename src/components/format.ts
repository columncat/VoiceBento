/**
 * 화면에 숫자를 적는 법.
 *
 * `src/lib/` 이 아니라 여기 사는 이유: 이 셋은 **보여 주기 위한 것뿐**이고
 * 서버는 하나도 안 쓴다. PaperBento 가 `components/upload-queue.ts` 를 같은
 * 이유로 컴포넌트 옆에 둔 것과 같은 결이다.
 */

/**
 * 초를 시계 모양으로. 타임스탬프와 길이 양쪽에 같은 함수를 쓴다.
 *
 * 한 시간이 넘어야 시(時) 칸이 생긴다. 10분짜리 녹음에 `0:05:32` 라고 적으면
 * 눈이 앞의 0 을 한 번 지나쳐야 한다.
 *
 * 소수점은 버린다 — 토큰 시각은 0.08초 눈금이라 소수를 적으면 정밀해 **보이는**
 * 숫자가 되는데, 실제 오차는 ±0.3초다. 있지도 않은 정밀도를 적지 않는다.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 길이를 사람 말로. 목록 카드처럼 눈으로 훑는 자리에 쓴다. */
export function formatLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "길이 모름";
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)}초`;
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}시간` : `${h}시간 ${rest}분`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * 전사에 걸릴 시간 어림.
 *
 * uno 에서 잰 값이다 — VAD 로 자른 뒤 조각마다 디코딩하는 경로의 RTF 가
 * 0.096 이었다 (60분 → 5분 46초, 10분 → 57초). 4코어 CPU 한 대 기준이라
 * 동시에 두 건이 돌면 그만큼 늘어난다. 그래서 "약" 이라고 적고 올려 잡는다.
 */
export const TRANSCRIBE_RTF = 0.1;

export function estimateTranscribe(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const est = seconds * TRANSCRIBE_RTF;
  if (est < 60) return `약 ${Math.max(5, Math.round(est / 5) * 5)}초`;
  return `약 ${Math.max(1, Math.round(est / 60))}분`;
}
