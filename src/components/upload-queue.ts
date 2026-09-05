import { apiFetch } from "@/lib/api-path";
import { api } from "@/lib/client-api";
import { isUnauthenticated, readJson } from "@/lib/read-json";
import type { RecordingDTO } from "@/lib/types";

/**
 * 미디어 올리는 줄.
 *
 * PaperBento 의 `upload-queue.ts` / MemoBento 의 `transfer-queue.ts` 와 같은
 * 3단(init/chunk/finish)이다. 여기서는 그 이유가 더 크다 — **한 시간짜리
 * 영상은 대개 100MB 를 넘고**, 앞에 선 Cloudflare 는 Free 플랜이라 본문
 * 100MB 에서 끊는다. 통짜로 보내면 그 파일은 아예 못 올린다.
 *
 * 조각마다 재시도하므로 1.2GB 짜리 강의 영상을 20분 올리다 한 번 끊겼다고
 * 처음부터 다시 하지 않는다.
 *
 * ## 한 번에 하나씩 올린다
 *
 * 병렬로 올리면 큰 파일 넷이 서로의 대역을 갉아먹어 넷 다 늦게 끝난다.
 * 게다가 뒤에서 전사가 도는데, 그건 워커 하나가 1.6GB 를 쓴다(uno 실측).
 * 올리는 순서가 곧 전사 순서라 앞의 것부터 끝내는 편이 사람에게도 낫다.
 *
 * ## `finish` 응답을 두 가지로 받는다
 *
 * 계약서에는 올리기 라우트가 없어서 `client-api.ts` 에서 모양을 가정했다.
 * 서버가 파일만 확정하면(`{ fileId }`) 여기서 이어 `POST /api/recordings` 를
 * 부르고, 녹음까지 세워 돌려주면(`{ recording }`) 그대로 쓴다. 뼈대 쪽이
 * 어느 쪽을 고르든 이 파일은 안 고쳐도 된다.
 */

export type UploadStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "registering"
  | "done"
  | "error"
  | "canceled";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** 올라간 바이트 수. */
  sent: number;
  error?: string;
  startedAt: number;
}

type Listener = (items: UploadItem[]) => void;

const items: UploadItem[] = [];
const listeners = new Set<Listener>();
const canceled = new Set<string>();
const queue: { item: UploadItem; file: File }[] = [];
let running = false;
let onReady: ((recording: RecordingDTO) => void) | null = null;

const CHUNK_RETRIES = 3;

function emit() {
  const snapshot = items.map((i) => ({ ...i }));
  listeners.forEach((l) => l(snapshot));
}

export function subscribeUploads(l: Listener): () => void {
  listeners.add(l);
  l(items.map((i) => ({ ...i })));
  return () => {
    listeners.delete(l);
  };
}

/** 한 건이 올라가 녹음이 설 때마다 부를 곳. 목록 화면이 그 자리에 끼워 넣는다. */
export function setUploadSink(fn: ((recording: RecordingDTO) => void) | null): void {
  onReady = fn;
}

export function cancelUpload(id: string): void {
  canceled.add(id);
  const item = items.find((i) => i.id === id);
  if (item && (item.status === "queued" || item.status === "preparing")) {
    item.status = "canceled";
    emit();
  }
}

export function clearFinishedUploads(): void {
  for (let i = items.length - 1; i >= 0; i--) {
    if (["done", "error", "canceled"].includes(items[i].status)) items.splice(i, 1);
  }
  emit();
}

/**
 * 확장자를 뗀 이름을 제목으로 삼는다.
 *
 * `2026-03-14 팀 회의.mp4` 를 그대로 제목에 넣으면 목록에서 `.mp4` 가 줄마다
 * 반복된다. 사람이 곧 고칠 이름이지만, 처음부터 읽을 만한 편이 낫다.
 */
export function titleFromFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.trim() || name;
}

export function enqueueUploads(files: File[]): void {
  for (const file of files) {
    const item: UploadItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      status: "queued",
      sent: 0,
      startedAt: Date.now(),
    };
    items.push(item);
    queue.push({ item, file });
  }
  emit();
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (canceled.has(next.item.id)) {
        next.item.status = "canceled";
        emit();
        continue;
      }
      await uploadOne(next.item, next.file);
    }
  } finally {
    running = false;
  }
}

class CanceledError extends Error {}

async function uploadOne(item: UploadItem, file: File): Promise<void> {
  item.status = "preparing";
  item.sent = 0;
  emit();

  const title = titleFromFilename(file.name);
  let uploadId: string | null = null;

  try {
    const initRes = await apiFetch("/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, title }),
    });
    const init = await readJson<{ uploadId?: string; chunkSize?: number }>(initRes);
    if (!init.uploadId || !init.chunkSize) throw new Error("업로드 자리를 받지 못했습니다");
    uploadId = init.uploadId;

    item.status = "uploading";
    emit();

    const chunkSize = init.chunkSize;
    const total = Math.max(1, Math.ceil(file.size / chunkSize));

    for (let index = 0; index < total; index++) {
      if (canceled.has(item.id)) throw new CanceledError();

      const start = index * chunkSize;
      const slice = file.slice(start, Math.min(file.size, start + chunkSize));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      if (bytes.byteLength === 0) break;

      await putChunkWithRetry(uploadId, index, bytes, item);

      item.sent = Math.min(file.size, start + bytes.byteLength);
      emit();
    }

    if (canceled.has(item.id)) throw new CanceledError();

    item.status = "registering";
    emit();

    const finRes = await apiFetch("/api/upload/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId, title }),
    });
    const fin = await readJson<{ fileId?: string; recording?: RecordingDTO }>(finRes);

    const recording = fin.recording ?? (fin.fileId ? await api.create(fin.fileId, title) : null);
    if (!recording) throw new Error("올린 파일을 확인하지 못했습니다");

    item.status = "done";
    item.sent = file.size;
    emit();
    onReady?.(recording);
  } catch (e) {
    /*
     * 반쯤 올라간 조각은 치운다 — 다만 로그인이 풀린 경우는 빼고.
     *
     * 한 시간짜리 영상은 조각 전송에만 수십 분이 걸린다. 마지막 확정에서
     * 세션이 만료되면 조각은 이미 서버에 다 올라간 뒤인데, 여기서 지워
     * 버리면 그 수십 분이 통째로 날아간다. 지우자고 보낸 요청도 어차피 같은
     * 이유로 거절된다. 남겨 두면 서버가 때가 되면 스스로 치운다.
     */
    if (uploadId && !isUnauthenticated(e)) {
      void apiFetch(`/api/upload/finish?id=${encodeURIComponent(uploadId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    if (e instanceof CanceledError || canceled.has(item.id)) {
      item.status = "canceled";
    } else {
      item.status = "error";
      item.error = isUnauthenticated(e)
        ? "로그인이 풀렸습니다. 새로고침하고 다시 시도하세요."
        : e instanceof Error
          ? e.message
          : "업로드 실패";
    }
    emit();
  }
}

async function putChunkWithRetry(
  uploadId: string,
  index: number,
  bytes: Uint8Array,
  item: UploadItem,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
    if (canceled.has(item.id)) throw new CanceledError();
    try {
      const res = await apiFetch(
        `/api/upload/chunk?id=${encodeURIComponent(uploadId)}&index=${index}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes as unknown as BodyInit,
        },
      );
      if (res.ok) return;
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      lastErr = new Error(j.error ?? `HTTP ${res.status}`);
      // 4xx 는 다시 보내도 같은 답이다.
      if (res.status >= 400 && res.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (e instanceof CanceledError) throw e;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error("조각 전송 실패");
}
