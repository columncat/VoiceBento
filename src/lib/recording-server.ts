import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "./db";
import type { JobState, RecordingRow, SegmentFlag, SegmentRow } from "./db/schema";
import type {
  RecordingDTO,
  RecordingNoticeDTO,
  RecordingWithSession,
  SegmentDTO,
  SummaryDTO,
} from "./types";
import { uid } from "./uid";

/**
 * 녹음·조각·요약을 만지는 **단일 진입점.**
 *
 * 라우트가 drizzle 을 직접 부르지 않게 한다. 같은 UPDATE 를 두 라우트가
 * 각자 쓰기 시작하면 `updated_at` 을 한쪽만 올리는 날이 오고, 목록의 정렬이
 * 조용히 어긋난다.
 */

// ─────────────────────────────────────────────────────────────
//   모양 바꾸기
// ─────────────────────────────────────────────────────────────

/**
 * 시각은 ISO 문자열로 나간다 (계약이 `string` 이다).
 *
 * epoch 숫자로 두면 화면이 시간대를 스스로 정해야 하고, 서버와 브라우저가
 * 다른 시간대일 때 하루가 어긋난다. ISO 는 그 정보를 스스로 들고 다닌다.
 */
function iso(d: Date): string {
  return d.toISOString();
}

export function toRecordingDTO(row: RecordingRow): RecordingDTO {
  return {
    id: row.id,
    title: row.title,
    fileId: row.fileId,
    duration: row.duration,
    state: row.state,
    /*
     * 진행률은 도는 중일 때만 싣는다.
     *
     * 끝난 녹음에 0.87 이 남아 있으면 화면이 그걸 보고 진행 막대를 그린다 —
     * 마지막 조각까지 끝냈어도 진행률은 1.0 에 딱 떨어지지 않는다(말이 없는
     * 구간은 VAD 가 건너뛰므로 처리한 조각 시간의 합이 전체 길이보다 짧다).
     * 그 값을 그대로 두면 다 끝난 것이 87%로 보인다.
     */
    progress: row.state === "extracting" || row.state === "transcribing" ? row.progress : null,
    error: row.error,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toSegmentDTO(row: SegmentRow): SegmentDTO {
  return {
    id: row.id,
    start: row.start,
    end: row.end,
    raw: row.raw,
    text: row.text,
    speaker: row.speaker,
    words: parseWords(row.words),
    edited: row.edited === 1,
    /*
     * 다듬기가 붙인 표시. 대개 null 이라 그때는 아예 안 싣는다 — 조각 수천
     * 줄에 `"flag":null` 을 붙이면 응답이 헛되이 커진다.
     */
    ...(row.flag ? { flag: row.flag } : {}),
  };
}

/** 낱말 JSON 은 워커가 쓴 것이지만, 깨져 있어도 화면이 멎으면 안 된다. */
function parseWords(raw: string): { w: string; t: number }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const w = (v as { w?: unknown }).w;
      const t = (v as { t?: unknown }).t;
      if (typeof w !== "string" || typeof t !== "number" || !Number.isFinite(t)) return [];
      return [{ w, t }];
    });
  } catch {
    return [];
  }
}

export function parseNotice(raw: string | null): RecordingNoticeDTO | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const kind = (parsed as { kind?: unknown }).kind;
    const text = (parsed as { text?: unknown }).text;
    if (kind !== "maybe-korean" && kind !== "mostly-empty") return null;
    if (typeof text !== "string" || !text) return null;
    return { kind, text };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//   녹음
// ─────────────────────────────────────────────────────────────

/**
 * 목록. 세션 이름까지 한 번의 질의로 붙여 온다.
 *
 * 녹음마다 세션을 따로 물으면 목록 한 번에 질의가 N+1 이 된다. 세션은
 * 없을 수도 있으므로 **왼쪽 바깥 조인**이다 — 안쪽 조인으로 두면 세션 없는
 * 녹음(세션이 생기기 전 것, 세션이 지워진 것)이 목록에서 통째로 사라진다.
 */
export function listRecordings(): RecordingWithSession[] {
  return db
    .select({ rec: schema.recordings, sessionName: schema.sessions.name })
    .from(schema.recordings)
    .leftJoin(schema.sessions, eq(schema.recordings.sessionId, schema.sessions.id))
    .orderBy(desc(schema.recordings.createdAt), desc(schema.recordings.id))
    .all()
    .map((r) => withSession(r.rec, r.sessionName));
}

/** 녹음 하나에 세션 이름을 얹는다. `RecordingDTO` 는 그대로 두고 넓힌 것만 만든다. */
export function withSession(row: RecordingRow, sessionName: string | null): RecordingWithSession {
  return {
    ...toRecordingDTO(row),
    sessionId: row.sessionId,
    sessionName: row.sessionId ? sessionName : null,
  };
}

export function getRecordingRow(id: string): RecordingRow | undefined {
  return db.select().from(schema.recordings).where(eq(schema.recordings.id, id)).get();
}

export function createRecording(input: {
  title: string;
  fileId: string | null;
  sourceName?: string;
  sourceSize?: number;
  /** 이어 붙일 세션. 없으면 null — 그때는 녹음 하나가 곧 세션이다. */
  sessionId?: string | null;
}): RecordingRow {
  const id = uid();
  db.insert(schema.recordings)
    .values({
      id,
      title: input.title.trim() || "제목 없음",
      fileId: input.fileId,
      sourceName: input.sourceName ?? "",
      sourceSize: input.sourceSize ?? 0,
      sessionId: input.sessionId ?? null,
      state: "queued",
    })
    .run();
  return getRecordingRow(id)!;
}

/**
 * 녹음을 다른 세션으로 옮긴다 (또는 세션에서 떼어 낸다).
 *
 * **옮겨도 지난 맥락이 따라가지는 않는다.** 저쪽 세션에 이미 쌓인 것은 옛
 * 세션에 남아 있고, 새 세션은 다음 다듬기·대화부터 이 녹음을 알게 된다.
 * 그게 자연스럽다 — 사람이 옮기는 뜻은 "앞으로 여기서 다루자" 이지 "지난
 * 대화를 저쪽으로 복사하자" 가 아니다.
 */
export function setRecordingSession(id: string, sessionId: string | null): RecordingRow | undefined {
  db.update(schema.recordings)
    .set({ sessionId, updatedAt: new Date() })
    .where(eq(schema.recordings.id, id))
    .run();
  return getRecordingRow(id);
}

export function renameRecording(id: string, title: string): RecordingRow | undefined {
  db.update(schema.recordings)
    .set({ title: title.trim() || "제목 없음", updatedAt: new Date() })
    .where(eq(schema.recordings.id, id))
    .run();
  return getRecordingRow(id);
}

export function deleteRecording(id: string): boolean {
  // 조각과 요약은 외래키의 cascade 로 딸려 지워진다 (`foreign_keys = ON` 이 조건).
  const r = db.delete(schema.recordings).where(eq(schema.recordings.id, id)).run();
  return r.changes > 0;
}

/**
 * 상태를 바꾼다. **조건을 걸 수 있게 열어 둔 것이 요점이다.**
 *
 * 워커의 진행을 받아 적는 코드와 사람이 누른 요청이 같은 행을 동시에 만진다.
 * "지금 `transcribing` 일 때만 `done` 으로" 처럼 조건을 걸면 늦게 온 쪽이
 * 0줄을 고치고 조용히 지나간다 — 끝난 것을 다시 도는 중으로 되돌리는 일이 없다.
 */
export function setRecordingState(
  id: string,
  patch: {
    state?: JobState;
    progress?: number | null;
    error?: string | null;
    duration?: number | null;
    notice?: string | null;
    polishJobId?: string | null;
    polishError?: string | null;
    polishStartedAt?: Date | null;
    attempts?: number;
  },
  onlyIf?: JobState[],
): boolean {
  const where = onlyIf?.length
    ? and(eq(schema.recordings.id, id), inArray(schema.recordings.state, onlyIf))
    : eq(schema.recordings.id, id);
  const r = db
    .update(schema.recordings)
    .set({ ...patch, updatedAt: new Date() })
    .where(where)
    .run();
  return r.changes > 0;
}

export function bumpAttempts(id: string): number {
  db.update(schema.recordings)
    .set({ attempts: sql`${schema.recordings.attempts} + 1`, updatedAt: new Date() })
    .where(eq(schema.recordings.id, id))
    .run();
  return getRecordingRow(id)?.attempts ?? 0;
}

// ─────────────────────────────────────────────────────────────
//   조각
// ─────────────────────────────────────────────────────────────

export function listSegments(recordingId: string): SegmentDTO[] {
  return db
    .select()
    .from(schema.segments)
    .where(eq(schema.segments.recordingId, recordingId))
    .orderBy(asc(schema.segments.idx))
    .all()
    .map(toSegmentDTO);
}

export function getSegmentRow(recordingId: string, id: string): SegmentRow | undefined {
  return db
    .select()
    .from(schema.segments)
    .where(and(eq(schema.segments.id, id), eq(schema.segments.recordingId, recordingId)))
    .get();
}

/**
 * 조각 한 줄을 앉힌다. **워커가 조각 하나를 끝낼 때마다 부른다.**
 *
 * 같은 자리에 두 번 오면(워커가 되살아나 같은 조각을 또 보내는 경우) 뒤엣것이
 * 이긴다 — 시간과 글자가 같을 것이므로 어느 쪽이든 상관없고, 부딪혀서 워커가
 * 멈추는 것보다 낫다.
 */
export function putSegment(input: {
  recordingId: string;
  idx: number;
  start: number;
  end: number;
  raw: string;
  words: { w: string; t: number }[];
}): void {
  db.insert(schema.segments)
    .values({
      id: uid(),
      recordingId: input.recordingId,
      idx: input.idx,
      start: input.start,
      end: input.end,
      raw: input.raw,
      // 다듬기 전에도 읽을 수 있어야 한다. 사람은 전사가 끝나자마자 읽기 시작한다.
      text: input.raw,
      words: JSON.stringify(input.words),
    })
    .onConflictDoUpdate({
      target: [schema.segments.recordingId, schema.segments.idx],
      set: {
        start: input.start,
        end: input.end,
        raw: input.raw,
        text: input.raw,
        words: JSON.stringify(input.words),
        updatedAt: new Date(),
      },
    })
    .run();
}

/** 사람이 고쳤다. `edited` 가 서는 순간이고, 그 뒤로는 다듬기가 이 줄을 안 건드린다. */
export function editSegment(
  recordingId: string,
  id: string,
  patch: { text?: string; speaker?: string | null },
): SegmentRow | undefined {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.text !== undefined) {
    set.text = patch.text;
    set.edited = 1;
  }
  if (patch.speaker !== undefined) {
    set.speaker = patch.speaker;
    /*
     * 화자만 고친 것도 사람이 고친 것이다.
     *
     * 여기서 `edited` 를 안 세우면, 다시 다듬을 때 에이전트가 사람이 손으로
     * 붙인 화자 이름을 "화자 1" 로 되돌린다. 그게 이 표시의 존재 이유다.
     */
    set.edited = 1;
  }
  db.update(schema.segments)
    .set(set)
    .where(and(eq(schema.segments.id, id), eq(schema.segments.recordingId, recordingId)))
    .run();
  return getSegmentRow(recordingId, id);
}

/**
 * 다듬은 결과를 얹는다. **사람이 고친 줄은 건너뛴다.**
 *
 * 돌려주는 것은 실제로 바뀐 줄 수다 — 하나도 안 바뀌었으면 화면이 그렇다고
 * 말할 수 있어야 한다 (에이전트가 형식을 어겼거나 전부 사람이 고친 것이다).
 *
 * ## 표시(`flag`)는 늘 덮어쓴다
 *
 * 다른 칸과 달리 `flag` 는 **없으면 지운다.** 그래야 하는 이유가 있다.
 * 처음 다듬을 때 "이 줄은 못 알아들은 말 같다"(`other-language`) 가 붙었고,
 * 사람이 무슨 녹음인지 쪽지를 적어 다시 다듬어 이번에는 제대로 다듬어졌다고
 * 하자. 이때 표시를 안 지우면 **멀쩡해진 줄에 경고가 그대로 남는다.**
 * 지난번 판단이 이번 결과를 덮는 셈이라 조용히 틀린 화면이 된다.
 *
 * 에이전트는 조각 하나에 줄 하나를 내므로, 다듬은 줄에는 늘 이 갈래가
 * 닿는다 — 표시가 안 온 줄은 "이번에는 표시할 것이 없다" 는 뜻이다.
 *
 * ## 사람이 고친 줄에는 표시도 안 붙인다
 *
 * 표시는 사람의 글이 아니라 기계의 판단이니 얹어도 될 것 같지만, 사람이
 * 고친 줄은 대개 **이상해서 고친 줄**이다. 거기에 "못 알아들은 것 같다" 가
 * 뒤늦게 붙으면 이미 고쳐 놓은 글에 경고만 달린다. 규칙은 하나여야 한다 —
 * 사람이 손댄 줄은 다듬기가 건드리지 않는다.
 */
export function applyPolish(
  recordingId: string,
  items: { i: number; text?: string; speaker?: string | null; flag?: SegmentFlag | null }[],
): number {
  let changed = 0;
  const now = new Date();
  db.transaction((tx) => {
    for (const item of items) {
      const set: Record<string, unknown> = { updatedAt: now };
      if (item.text !== undefined) set.text = item.text;
      if (item.speaker !== undefined) set.speaker = item.speaker;
      // 위 설명대로 늘 쓴다. 안 온 것은 "표시 없음" 이다.
      set.flag = item.flag ?? null;

      /*
       * 예전에는 여기 "바꿀 것이 없으면 건너뛴다" 가 있었다. 지금은 없다 —
       * `flag` 를 늘 쓰므로 빈 UPDATE 가 나올 수 없고, 아무것도 안 든 항목은
       * 애초에 여기까지 오지 않는다 (`agent.ts` 의 `readItems` 가 버린다).
       */
      const r = tx
        .update(schema.segments)
        .set(set)
        .where(
          and(
            eq(schema.segments.recordingId, recordingId),
            eq(schema.segments.idx, item.i),
            // 사람이 고친 줄은 안 덮는다. 조건을 SQL 에 걸어 두면 빠뜨릴 길이 없다.
            eq(schema.segments.edited, 0),
          ),
        )
        .run();
      changed += r.changes;
    }
  });
  return changed;
}

/** 다시 전사할 때 앞의 것을 치운다. */
export function clearSegments(recordingId: string): void {
  db.delete(schema.segments).where(eq(schema.segments.recordingId, recordingId)).run();
}

export function countSegments(recordingId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.segments)
    .where(eq(schema.segments.recordingId, recordingId))
    .get();
  return row?.n ?? 0;
}

// ─────────────────────────────────────────────────────────────
//   요약
// ─────────────────────────────────────────────────────────────

export function getSummaryRow(recordingId: string) {
  return db
    .select()
    .from(schema.summaries)
    .where(eq(schema.summaries.recordingId, recordingId))
    .get();
}

export function toSummaryDTO(
  row: NonNullable<ReturnType<typeof getSummaryRow>>,
): SummaryDTO | null {
  // 아직 아무 글도 없으면 요약이 있는 것이 아니다 (작업 상태만 있는 행이다).
  if (!row.body.trim()) return null;
  return {
    body: row.body,
    source: row.source,
    instruction: row.instruction,
    updatedAt: iso(row.updatedAt),
  };
}

export function setSummary(
  recordingId: string,
  body: string,
  opts: { source: "human" | "agent"; instruction?: string | null },
): void {
  db.insert(schema.summaries)
    .values({
      recordingId,
      body,
      source: opts.source,
      instruction: opts.instruction ?? null,
    })
    .onConflictDoUpdate({
      target: schema.summaries.recordingId,
      set: {
        body,
        source: opts.source,
        instruction: opts.instruction ?? null,
        updatedAt: new Date(),
      },
    })
    .run();
}
