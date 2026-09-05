import { desc, eq, sql } from "drizzle-orm";

import { db, schema } from "./db";
import type { RecordingRow, SessionRow } from "./db/schema";
import { env } from "./env";
import type { SessionDTO } from "./types";
import { uid } from "./uid";

/**
 * 세션 — **한 전사문이 처리되는 자리.**
 *
 * ## 무엇이 세션인가
 *
 * 이름 하나와 에이전트 세션 열쇠 하나. 녹음이 여럿 붙을 수 있고, 그 녹음들의
 * 다듬기와 대화가 **같은 에이전트 세션**에서 돈다.
 *
 * 예전에는 녹음 하나가 곧 세션이었다. 그래서 두 가지가 안 됐다.
 *
 * 1. 방금 다듬으며 정한 화자 이름과 용어를 대화창이 몰랐다 (다듬기가
 *    일회용 세션이었다).
 * 2. 지난주 회의에서 배운 것을 이번 주 회의가 물려받을 길이 없었다.
 *
 * 주간 회의처럼 같은 사람·같은 용어가 되풀이되는 자리에서 값이 나온다.
 *
 * ## 도구는 여전히 안 준다
 *
 * 세션이 오래 살수록 이 규율이 더 중요해진다. 여기 실려 가는 것은 **남이
 * 만든 소리에서 받아 적은 글**이고, 세션이 길어질수록 그런 글이 쌓인다.
 * 도구가 하나라도 달리면 마이크 앞에서 읽은 문장이 남의 앱에 대한 쓰기가
 * 되고, 세션이 길면 그 문장이 여러 턴 뒤까지 살아 있다. 그래서 늘리는 것은
 * 맥락이지 권한이 아니다.
 */

// ─────────────────────────────────────────────────────────────
//   에이전트 열쇠
// ─────────────────────────────────────────────────────────────

/**
 * 세션 열쇠 앞에 붙이는 것. **녹음 id 와 겹치지 않게 하려고 있다.**
 *
 * 세션이 없는 녹음은 예전 그대로 **녹음 id 자체**가 열쇠다 (아래
 * `agentKeyFor`). 세션 열쇠도 같은 `uid()` 에서 나오므로, 접두어가 없으면
 * 언젠가 세션 하나와 녹음 하나가 같은 열쇠를 들 수 있다. 그러면 저쪽에서는
 * 한 세션이 되어 **아무 상관 없는 두 맥락이 조용히 섞인다.** 화면에는 그
 * 사실이 어디에도 안 뜬다.
 *
 * `-` 는 BentoAgent 의 `isChatKey` (`/^[A-Za-z0-9_-]{1,64}$/`) 가 받는 글자다.
 */
const SESSION_KEY_PREFIX = "s-";

function newAgentKey(): string {
  return `${SESSION_KEY_PREFIX}${uid()}`;
}

/**
 * 이 녹음이 에이전트를 부를 때 쓸 열쇠.
 *
 * 세션이 있으면 세션의 열쇠, 없으면 **녹음 id 그대로**다. 뒤엣것이 중요하다 —
 * 세션이 생기기 전에 올린 녹음의 대화 기록이 저쪽에 `recordingId` 로 쌓여
 * 있고, 여기서 열쇠 모양을 바꾸면 그 기록이 통째로 고아가 된다. 사람 눈에는
 * "대화가 사라졌다" 로 보인다.
 */
export function agentKeyFor(row: Pick<RecordingRow, "id" | "sessionId">): string {
  if (!row.sessionId) return row.id;
  const s = getSessionRow(row.sessionId);
  return s ? s.agentKey : row.id;
}

// ─────────────────────────────────────────────────────────────
//   맥락 상한
// ─────────────────────────────────────────────────────────────

/**
 * 세션 하나가 에이전트 맥락에 부을 수 있는 글자 수.
 *
 * ## 어디서 끊는가
 *
 * 세는 것은 **우리가 부은 것**이다 — 다듬기에 넘긴 날 것과, 대화에 매 턴
 * 싣는 전사문. 저쪽 세션은 `--resume` 으로 이어 붙으므로 그 기록은 줄어들지
 * 않는다. 에이전트가 낸 답까지는 못 세지만, 부은 쪽이 압도적으로 크다.
 *
 * 기본 60만 자 — 영어로 15만 토큰쯤이고, 한 시간짜리 녹음의 전사문이 4만
 * 자쯤이라 주간 회의를 열 번 넘게 쌓아도 안 닿는다 (`env.ts` 의 근거).
 *
 * ## 넘치면 무엇을 하는가 — **조용히 자르지 않는다**
 *
 * 잘라 보내면 에이전트는 앞부분을 잃은 줄 모른 채 "그런 얘기는 없습니다" 라고
 * 답한다. 없는 것과 우리가 안 보낸 것이 화면에서 같아지는데, 그것이 이 앱에서
 * 가장 나쁜 실패다.
 *
 * 그래서 **거절하고 두 갈래를 말한다.**
 *
 * 1. 이 녹음을 새 세션으로 옮긴다 — 지난 맥락을 안 물려받는 대신 깨끗하다.
 * 2. 이 세션을 `rollover` 한다 — 이름과 녹음 목록은 그대로 두고 에이전트
 *    맥락만 새로 시작한다. 대화 기록은 사라지지만 전사문은 그대로다.
 *
 * 둘 다 사람이 고르는 일이다. 우리가 대신 고르지 않는다.
 */
export const SESSION_CONTEXT_LIMIT = env.SESSION_CONTEXT_CHARS;

export class SessionContextFullError extends Error {
  constructor(
    readonly session: SessionRow,
    readonly wouldAdd: number,
  ) {
    super(
      `세션 "${session.name}" 의 맥락이 상한에 닿았습니다 ` +
        `(${session.contextChars.toLocaleString()} + ${wouldAdd.toLocaleString()} > ` +
        `${SESSION_CONTEXT_LIMIT.toLocaleString()}자). ` +
        `잘라 보내면 에이전트가 못 본 대목을 "없다" 고 답하므로 보내지 않았습니다. ` +
        `이 녹음을 새 세션으로 옮기거나, 이 세션의 에이전트 맥락을 새로 시작하세요 ` +
        `(세션 이름과 붙어 있는 녹음은 그대로 남고, 오간 대화만 사라집니다).`,
    );
    this.name = "SessionContextFullError";
  }
}

/**
 * 이만큼 부어도 되는지 묻고, 되면 **곧바로 적어 둔다.**
 *
 * 묻는 것과 적는 것을 갈라 두면 그 사이에 다른 요청이 끼어든다. 지금은
 * 다듬기가 세션마다 줄을 서지만(`agent-queue.ts`), 대화는 안 선다 —
 * 저쪽에서 서기 때문이다. 여기서 두 걸음으로 나누면 그 틈으로 상한을 넘긴
 * 두 요청이 나란히 통과한다.
 *
 * 세션이 없는 녹음(`sessionId === null`)은 셀 것이 없다. 그때는 녹음 하나가
 * 곧 세션이고, 그 세션은 이 녹음 하나만큼만 자란다.
 */
/**
 * 부어도 되는지 **묻기만** 한다. 아무것도 안 적는다.
 *
 * 줄을 서기 **전에** 묻는 자리다. 다듬기는 같은 세션끼리 줄을 서므로, 부을
 * 때가 되어서야 "맥락이 찼습니다" 를 알게 되면 사람은 몇 분을 기다린 뒤에
 * 그 말을 듣는다. 값싼 검사는 앞에서 하는 것이 맞다.
 *
 * 실제로 적는 것은 여전히 `spendContext` 다. 그 사이에 다른 요청이 부을 수
 * 있으므로 여기 통과가 보장은 아니다 — 그래서 두 곳 다 있는 것이다.
 */
export function assertContextRoom(sessionId: string | null, chars: number): void {
  if (!sessionId) return;
  const row = getSessionRow(sessionId);
  if (!row) return;
  if (row.contextChars + chars > SESSION_CONTEXT_LIMIT) {
    throw new SessionContextFullError(row, chars);
  }
}

export function spendContext(sessionId: string | null, chars: number): void {
  if (!sessionId) return;
  const row = getSessionRow(sessionId);
  if (!row) return;
  if (row.contextChars + chars > SESSION_CONTEXT_LIMIT) {
    throw new SessionContextFullError(row, chars);
  }
  db.update(schema.sessions)
    .set({
      contextChars: sql`${schema.sessions.contextChars} + ${chars}`,
      updatedAt: new Date(),
    })
    .where(eq(schema.sessions.id, sessionId))
    .run();
}

/** 지금 몇 %인가. 화면이 **미리** 알려 줄 재료 — 닿고 나서 아는 것은 늦다. */
export function contextRoom(row: SessionRow): { used: number; limit: number; full: boolean } {
  return {
    used: row.contextChars,
    limit: SESSION_CONTEXT_LIMIT,
    full: row.contextChars >= SESSION_CONTEXT_LIMIT,
  };
}

// ─────────────────────────────────────────────────────────────
//   읽기
// ─────────────────────────────────────────────────────────────

export function getSessionRow(id: string): SessionRow | undefined {
  return db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
}

/** 이 세션에 붙은 녹음 수. 목록마다 세션마다 세므로 색인을 하나 두었다. */
export function countRecordings(sessionId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.recordings)
    .where(eq(schema.recordings.sessionId, sessionId))
    .get();
  return row?.n ?? 0;
}

export function toSessionDTO(row: SessionRow): SessionDTO {
  return {
    id: row.id,
    name: row.name,
    recordingCount: countRecordings(row.id),
    contextChars: row.contextChars,
    contextLimit: SESSION_CONTEXT_LIMIT,
    contextFull: row.contextChars >= SESSION_CONTEXT_LIMIT,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 최근에 손댄 순. 올릴 때 고르는 칸이 그 순서로 뜬다 — 방금 쓰던 것이 위다.
 *
 * 두 번째 잣대가 `rowid` 인 이유: 시각이 **초 단위**다 (`unixepoch()`,
 * 형제 앱들과 같은 관례). 한 번에 세션 둘을 만들면 같은 초에 들어가고,
 * 그때 id 로 가르면 순서가 제멋대로다 — `uid()` 앞머리가 난수라서 만든
 * 순서와 아무 상관이 없다. 실제로 시험에서 뒤집혔다.
 *
 * `rowid` 는 넣은 순서대로 커지므로 같은 초 안에서도 만든 순서를 지킨다.
 * (`sessions` 는 TEXT 기본키라 WITHOUT ROWID 가 아니고, 그래서 rowid 가 있다.)
 */
export function listSessions(): SessionDTO[] {
  return db
    .select()
    .from(schema.sessions)
    .orderBy(desc(schema.sessions.updatedAt), desc(sql`rowid`))
    .all()
    .map(toSessionDTO);
}

export function sessionOfRecording(row: Pick<RecordingRow, "sessionId">): SessionRow | null {
  if (!row.sessionId) return null;
  return getSessionRow(row.sessionId) ?? null;
}

// ─────────────────────────────────────────────────────────────
//   쓰기
// ─────────────────────────────────────────────────────────────

/** 이름의 상한. 여기에 문단이 들어오면 그건 이름이 아니다. */
export const MAX_SESSION_NAME = 120;

/**
 * 이름 손질. **제어문자와 폭 0 문자를 턴다.**
 *
 * 세션 이름은 목록과 카드에 그대로 뜨는 글이고, 만드는 입구가 사람의
 * 브라우저 하나가 아니다 (에이전트도 부를 수 있다).
 *
 * 유니코드 갈래 `\p{C}` 로 적는 것은 **소스에 제어문자를 직접 박지 않기
 * 위해서**다. 번호를 나열한 문자 클래스는 읽기도 어렵고, 편집기를 한 번
 * 지날 때마다 그 자리에 진짜 제어문자가 들어앉을 수 있다. 공백류를 먼저
 * 한 칸으로 모으고 남은 것을 턴다 (BentoAgent 의 `oneLine()` 과 같은 손질).
 */
function cleanName(raw: string): string {
  const s = raw
    .replace(/\s+/gu, " ")
    .replace(/\p{C}/gu, "")
    .trim();
  return s.slice(0, MAX_SESSION_NAME) || "이름 없는 세션";
}

export function createSession(name: string): SessionRow {
  const id = uid();
  db.insert(schema.sessions)
    .values({ id, name: cleanName(name), agentKey: newAgentKey() })
    .run();
  return getSessionRow(id)!;
}

export function renameSession(id: string, name: string): SessionRow | undefined {
  db.update(schema.sessions)
    .set({ name: cleanName(name), updatedAt: new Date() })
    .where(eq(schema.sessions.id, id))
    .run();
  return getSessionRow(id);
}

/**
 * 세션을 지운다. **붙어 있던 녹음의 전사문은 남는다.**
 *
 * 외래키가 `ON DELETE SET NULL` 이라 녹음은 세션을 잃을 뿐이다
 * (`drizzle/0001_sessions.sql` 에 근거를 적어 두었다). 그 녹음들은 예전처럼
 * 녹음 하나가 곧 세션인 상태로 돌아가고, 다듬기도 대화도 그대로 된다.
 *
 * 돌려주는 수는 "세션을 잃은 녹음이 몇 건인가" 다. 화면이 지우기 전에
 * 그 수를 보여 줄 수 있어야 한다.
 */
export function deleteSession(id: string): { deleted: boolean; recordingsKept: number } {
  const kept = countRecordings(id);
  const r = db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
  return { deleted: r.changes > 0, recordingsKept: kept };
}

/**
 * 에이전트 맥락만 새로 시작한다. **세션 이름도 녹음도 그대로 둔다.**
 *
 * 맥락이 상한에 닿았을 때의 한 갈래다. 열쇠를 갈면 저쪽에서는 새 세션이
 * 열리므로 쌓인 기록이 통째로 떨어져 나간다 — 그것이 목적이다.
 *
 * **잃는 것이 있다.** 저쪽에 쌓인 대화 기록(`/voice/history`)은 옛 열쇠에
 * 매여 있어 화면에서 사라진다. 전사문과 다듬은 결과와 요약은 우리 DB 에
 * 있으므로 하나도 안 잃는다. 그리고 대화는 어차피 **매 턴 전사문을 다시
 * 실어 보내므로** 다음 한 마디부터 곧바로 제 일을 한다.
 *
 * 그래서 이건 사람이 눌러야 하는 단추다. 서버가 알아서 하지 않는다.
 */
export function rolloverSession(id: string): SessionRow | undefined {
  db.update(schema.sessions)
    .set({ agentKey: newAgentKey(), contextChars: 0, updatedAt: new Date() })
    .where(eq(schema.sessions.id, id))
    .run();
  return getSessionRow(id);
}

/** 손댄 때를 올린다. 목록 정렬이 "방금 쓰던 것" 을 위로 올리는 근거다. */
export function touchSession(id: string | null): void {
  if (!id) return;
  db.update(schema.sessions)
    .set({ updatedAt: new Date() })
    .where(eq(schema.sessions.id, id))
    .run();
}

// ─────────────────────────────────────────────────────────────
//   올릴 때 고르기
// ─────────────────────────────────────────────────────────────

export class SessionPickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPickError";
  }
}

/**
 * 올리는 요청에 붙은 세션 선택을 실제 세션 id 로 바꾼다.
 *
 * - `sessionId` — 있는 세션. 없는 id 면 **거절한다.** 조용히 새로 만들거나
 *   세션 없이 두면, 사람은 이어 붙였다고 믿는데 실제로는 안 붙어 있다.
 * - `newSessionName` — 그 이름으로 새로 만든다.
 * - 둘 다 없으면 null (세션 없이).
 * - **둘 다 오면 거절한다.** 어느 쪽이 뜻인지 짐작하지 않는다.
 */
export function resolveSessionPick(pick: {
  sessionId?: string | null;
  newSessionName?: string | null;
}): string | null {
  const id = pick.sessionId?.trim() || null;
  const name = pick.newSessionName?.trim() || null;

  if (id && name) {
    throw new SessionPickError(
      "sessionId 와 newSessionName 을 함께 줄 수 없습니다. 이어 붙일 세션을 고르거나 새로 만드세요.",
    );
  }
  if (id) {
    if (!getSessionRow(id)) {
      throw new SessionPickError("고르신 세션을 찾을 수 없습니다 (지워졌을 수 있습니다)");
    }
    return id;
  }
  if (name) return createSession(name).id;
  return null;
}
