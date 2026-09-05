import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { env } from "./env";
import { uid } from "./uid";

/**
 * 올리기 세션 — **바이트를 들고 있지 않다.**
 *
 * PaperBento·MemoBento 의 조각 올리기는 조각을 제 디스크의 `.part` 에 써
 * 넣었다가 마지막에 파일로 확정한다. 여기서는 그러지 않는다. 이 앱의 파일
 * 저장소는 MemoBento 이고, 조각은 **받는 즉시 그대로 그쪽으로 흘려보낸다.**
 *
 * 왜 그렇게 했나.
 *
 * - 같은 바이트를 두 번 적을 이유가 없다. 한 시간짜리 영상이면 그것만으로
 *   디스크 쓰기가 몇 GB 다.
 * - "이 앱에도 파일이 있고 저쪽에도 있다" 가 되면 지우기와 되살리기가 두 곳을
 *   맞춰야 한다. 저장소가 하나면 그런 어긋남 자체가 없다.
 *
 * 그래서 이 파일이 들고 있는 것은 **우리 세션 번호와 MemoBento 세션 번호의
 * 짝짓기**뿐이다. 그것도 디스크에 둔다 — 메모리에 두면 앱이 다시 뜨는 순간
 * 올리던 사람이 이유 없는 404 를 받는다. 파일이면 적어도 무엇이 있었는지
 * 남고, 이어 보내던 조각이 제자리를 찾는다.
 */

export interface UploadSession {
  /** 우리 쪽 번호. 브라우저가 들고 다닌다. */
  id: string;
  /** MemoBento 쪽 번호. 조각을 그리로 넘길 때 쓴다. */
  remoteId: string;
  name: string;
  size: number;
  createdAt: number;
}

function dir(): string {
  return join(resolve(env.WORK_DIR), ".uploads");
}

function metaPath(id: string): string {
  return join(dir(), `${id}.json`);
}

/** 경로 조작 차단. id 는 우리가 만든 것이라 모양이 정해져 있다. */
function safeId(id: string): boolean {
  return /^[a-z0-9]{1,40}$/i.test(id);
}

export async function createSession(input: {
  remoteId: string;
  name: string;
  size: number;
}): Promise<UploadSession> {
  await mkdir(dir(), { recursive: true });
  const session: UploadSession = {
    id: uid(),
    remoteId: input.remoteId,
    name: input.name,
    size: input.size,
    createdAt: Date.now(),
  };
  await writeFile(metaPath(session.id), JSON.stringify(session));
  return session;
}

export async function loadSession(id: string): Promise<UploadSession | null> {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(await readFile(metaPath(id), "utf8")) as UploadSession;
  } catch {
    return null;
  }
}

export async function discard(id: string): Promise<void> {
  if (!safeId(id)) return;
  await rm(metaPath(id), { force: true }).catch(() => undefined);
}
