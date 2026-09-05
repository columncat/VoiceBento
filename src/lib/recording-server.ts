import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "./db";
import type { JobState, RecordingRow, SegmentRow } from "./db/schema";
import type {
  RecordingDTO,
  RecordingNoticeDTO,
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

export function listRecordings(): RecordingDTO[] {
  return db
    .select()
    .from(schema.recordings)
    .orderBy(desc(schema.recordings.createdAt), desc(schema.recordings.id))
    .all()
    .map(toRecordingDTO);
}

export function getRecordingRow(id: string): RecordingRow | undefined {
  return db.select().from(schema.recordings).where(eq(schema.recordings.id, id)).get();
}

export function createRecording(input: {
  title: string;
  fileId: string | null;
  sourceName?: string;
  sourceSize?: number;
}): RecordingRow {
  const id = uid();
  db.insert(schema.recordings)
    .values({
      id,
      title: input.title.trim() || "제목 없음",
      fileId: input.fileId,
      sourceName: input.sourceName ?? "",
      sourceSize: input.sourceSize ?? 0,
      state: "queued",
    })
    .run();
  return getRecordingRow(id)!;
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
 */
export function applyPolish(
  recordingId: string,
  items: { i: number; text?: string; speaker?: string | null }[],
): number {
  let changed = 0;
  const now = new Date();
  db.transaction((tx) => {
    for (const item of items) {
      const set: Record<string, unknown> = { updatedAt: now };
      if (item.text !== undefined) set.text = item.text;
      if (item.speaker !== undefined) set.speaker = item.speaker;
      if (Object.keys(set).length === 1) continue;

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
