import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, or, isNull, sql } from "drizzle-orm";

import { db, schema } from "./db";
import type {
  DiarizationRow,
  JobState,
  RecordingRow,
  SegmentFlag,
  SegmentRow,
  SpeakerState,
} from "./db/schema";
import { OTHER_SPEAKER } from "./diar-models";
import {
  assignSpeakers,
  carryPlan,
  clusterName,
  placeholderNames,
  type SegmentSpeaker,
  type SpeakerRun,
} from "./diarize-assign";
import { cleanName, dedupeNames, nameKey } from "./name-key";
import type {
  DiarizationDTO,
  RecordingDTO,
  RecordingNoticeDTO,
  RecordingWithSession,
  SegmentDTO,
  SpeakerRunDTO,
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

/**
 * 군집 번호를 화면에 적을 이름으로 푸는 함수. 분리를 안 한 녹음이면 늘 null.
 *
 * **이름을 조각마다 베껴 두지 않는 이유가 이 함수다.** 군집 → 이름 표는
 * 녹음 하나에 하나뿐이라(`diarizations.names`), 이름 하나를 고치면 그 표
 * 한 칸만 바뀌면 된다. 조각에 이름을 박아 두면 수천 줄을 다시 써야 하고
 * 그중 한 줄이라도 빠지면 같은 사람이 두 이름으로 앉는다.
 */
export type SpeakerNamer = (cluster: number | null) => string | null;

export function speakerNamer(diar: DiarizationRow | undefined): SpeakerNamer {
  if (!diar) return () => null;
  const names = parseNames(diar.names);
  const order = parseTalkTime(diar.talkTime).map((t) => t.k);
  const roster = readRoster(diar.roster);
  const fallback = placeholderNames(order, roster.length, OTHER_SPEAKER);
  return (k) => clusterName(k, names, fallback);
}

/**
 * 조각 한 줄을 화면 모양으로.
 *
 * `namer` 를 안 주면 소리로 가른 이름이 안 풀린다 — 그 갈래를 일부러 남겨
 * 둔다. 이름 표는 녹음마다 한 번만 읽으면 되는 것이라(`listSegments`),
 * 줄마다 DB 를 찌르게 만들면 조각 수천 줄짜리 전사문에서 그대로 드러난다.
 */
export function toSegmentDTO(row: SegmentRow, namer?: SpeakerNamer): SegmentDTO {
  const runs = parseRuns(row.speakerRuns);
  /*
   * 소리로 가른 줄은 **번호를 풀어** 이름을 만든다. 그 밖의 줄은 예전 그대로
   * `speaker` 칸이 이긴다 — 에이전트가 추정한 옛 이름과 사람이 손으로 적은
   * 이름이 거기 있고, 둘 다 덮으면 안 된다.
   */
  const resolved =
    row.speakerSource === "acoustic" && namer ? namer(row.speakerCluster) : null;

  return {
    id: row.id,
    start: row.start,
    end: row.end,
    raw: row.raw,
    text: row.text,
    speaker: resolved ?? row.speaker,
    words: parseWords(row.words),
    edited: row.edited === 1,
    /*
     * 다듬기가 붙인 표시. 대개 null 이라 그때는 아예 안 싣는다 — 조각 수천
     * 줄에 `"flag":null` 을 붙이면 응답이 헛되이 커진다.
     */
    ...(row.flag ? { flag: row.flag } : {}),
    /*
     * 화자 분리가 붙인 것도 있을 때만 싣는다. 같은 까닭이다 — 옛 녹음
     * 수천 줄에 `"speakerRuns":[]` 를 얹을 이유가 없다.
     */
    ...(row.speakerSource ? { speakerSource: row.speakerSource } : {}),
    ...(row.speakerCluster !== null ? { speakerCluster: row.speakerCluster } : {}),
    ...(runs.length ? { speakerRuns: runs } : {}),
    ...(row.speakerSil !== null ? { speakerSil: row.speakerSil } : {}),
  };
}

/** 화자 토막 JSON. 워커가 아니라 우리가 쓴 것이지만, 깨져도 화면이 멎으면 안 된다. */
function parseRuns(raw: string): SpeakerRunDTO[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const { k, s, e, sil } = v as Record<string, unknown>;
      if (typeof k !== "number" || typeof s !== "number" || typeof e !== "number") return [];
      if (!Number.isFinite(s) || !Number.isFinite(e)) return [];
      return [{ k, s, e, sil: typeof sil === "number" && Number.isFinite(sil) ? sil : null }];
    });
  } catch {
    return [];
  }
}

function parseStringList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * 저장된 **화자 목록** JSON 을 읽는다 — 녹음의 목록이든 분리 행에 앉은 그 판의 목록이든.
 *
 * 읽을 때도 같음 열쇠로 거른다 (`dedupeNames`). 같음 규칙이 두 벌이던 때나 형식 문자를
 * 안 지우던 때 앉은 목록(`["Kim","kim"]`, `"Kim"`+U+200B)이 DB 에 남아 있을 수 있다. 녹음
 * 쪽(`getRoster`)만 거르고 분리 행 쪽을 날로 읽으면, 같은 녹음에서 임시 이름을 몇 명까지
 * 줄지(`speakerNamer`) · 화면의 "목록 밖" 표시(DTO) · 에이전트 이름의 닫힌 집합
 * (`setAgentDiarNames`)이 k 를 셀 때와 다른 인원을 본다.
 */
function readRoster(raw: string): string[] {
  return dedupeNames(parseStringList(raw));
}

function parseTalkTime(raw: string): { k: number; seconds: number }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const { k, seconds } = v as Record<string, unknown>;
      if (typeof k !== "number" || typeof seconds !== "number") return [];
      return [{ k, seconds }];
    });
  } catch {
    return [];
  }
}

function parseNames(raw: string): Record<number, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(k);
      if (!Number.isInteger(n)) continue;
      if (typeof v === "string" && v.trim()) out[n] = v;
    }
    return out;
  } catch {
    return {};
  }
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
    /*
     * 화자 분리 상태는 **`state` 와 나란히** 간다. 섞지 않는다 — 분리가
     * 실패해도 전사문은 온전하고 `state` 는 `done` 이다.
     */
    speakerState: row.speakerState,
    speakerError: row.speakerError,
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
    /** 화자 분리의 상태. **`state` 를 건드리지 않고** 여기만 옮긴다. */
    speakerState?: SpeakerState;
    speakerError?: string | null;
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
  // 이름 표는 **한 번만** 읽는다. 줄마다 읽으면 조각 수천 줄에서 그대로 드러난다.
  const namer = speakerNamer(getDiarizationRow(recordingId));
  return db
    .select()
    .from(schema.segments)
    .where(eq(schema.segments.recordingId, recordingId))
    .orderBy(asc(schema.segments.idx))
    .all()
    .map((row) => toSegmentDTO(row, namer));
}

/**
 * 화자를 붙일 때 쓰는 **최소한의** 조각 목록.
 *
 * `listSegments` 를 안 쓰는 이유가 둘이다. 하나는 붙이는 셈에 필요 없는
 * 것(다듬은 글·표시·낱말 JSON 을 푼 결과)을 수천 줄어치 만들지 않으려는
 * 것이고, 다른 하나는 **`raw` 를 넘겨야 하기 때문**이다 — 낱말 시각이 없는
 * 모델에서 글자 수로 나눌 때 기준이 되는 글은 `text` 가 아니라 `raw` 여야
 * 한다. `text` 는 다듬기와 사람 손질로 바뀌고, 그러면 같은 소리에 대한 화자
 * 경계가 글을 고칠 때마다 움직인다.
 */
export function listSegmentsForAssign(
  recordingId: string,
): { idx: number; start: number; end: number; words: { w: string; t: number }[]; raw: string }[] {
  return db
    .select({
      idx: schema.segments.idx,
      start: schema.segments.start,
      end: schema.segments.end,
      words: schema.segments.words,
      raw: schema.segments.raw,
    })
    .from(schema.segments)
    .where(eq(schema.segments.recordingId, recordingId))
    .orderBy(asc(schema.segments.idx))
    .all()
    .map((r) => ({
      idx: r.idx,
      start: r.start,
      end: r.end,
      words: parseWords(r.words),
      raw: r.raw,
    }));
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
    /*
     * 근거도 함께 바꾼다. **이 줄의 이름은 이제 사람의 것이다.**
     *
     * 이게 없으면 다시 붙일 때(`putSpeakerAssignments`) 소리로 가른 값이
     * 사람이 적은 이름을 덮는다. 그리고 화면은 `speakerSource` 로 이름의
     * 무게를 가르는데, 사람이 고친 줄에 `acoustic` 이 남아 있으면 그 표시가
     * 거짓이 된다.
     */
    set.speakerSource = "human";
    /*
     * 군집 번호는 **지운다.** 사람이 이름을 바꿨다는 것은 소리가 가른 것이
     * 틀렸다는 뜻인데, 번호를 남겨 두면 `toSegmentDTO` 가 그 번호로 이름을
     * 풀어 사람의 이름을 덮을 길이 남는다.
     */
    set.speakerCluster = null;
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
 *
 * ## 화자는 **안 받는다.** 이 칸이 없어진 것이 요점이다
 *
 * 예전에는 여기 `if (item.speaker !== undefined) set.speaker = item.speaker;`
 * 한 줄이 있었다. 다듬기 응답이 줄마다 화자 이름을 덮어쓰는 자리였다.
 *
 * 지금 화자는 **소리로 가른다.** 에이전트는 대사를 읽고 **군집 → 이름 표
 * 하나**만 정한다 (`setDiarNames`). 줄마다 이름을 돌려받는 길을 남겨 두면
 * 그 두 근거가 한 화면에서 뒤섞이는데, 어느 줄이 어느 근거에서 나온
 * 것인지는 아무 데도 안 보인다. 그래서 문을 아예 없앴다 — `agent.ts` 의
 * 허용목록(`readItems`)에서도 함께 버린다 (fail closed).
 *
 * 근거: 음향이 말한 시간 순서만으로 이름을 맞히면 64.9%(신탁 70.6%)이고
 * 개별 파일에서 20%까지 무너진다. 그래서 **이름은 에이전트가 정하는 것이
 * 맞다.** 다만 정하는 단위가 줄이 아니라 군집이어야 한다.
 */
export function applyPolish(
  recordingId: string,
  items: { i: number; text?: string; flag?: SegmentFlag | null }[],
): number {
  let changed = 0;
  const now = new Date();
  db.transaction((tx) => {
    for (const item of items) {
      const set: Record<string, unknown> = { updatedAt: now };
      if (item.text !== undefined) set.text = item.text;
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

/**
 * 다시 전사할 때 앞의 것을 치운다. **목소리에 붙인 이름은 남긴다.**
 *
 * 조각은 지운다. 조각마다 붙은 화자(`speakerCluster`·`speakerRuns`)와 줄에서 손으로
 * 고친 화자도 함께 사라진다 — 조각이 새로 매겨지니 그 짝은 이미 틀린 것이다.
 *
 * 분리 행(`diarizations`)은 **지우지 않는다.** 예전에는 여기서 함께 지웠고, 그러면
 * 사람이 목소리마다 붙인 이름이 "다시 확인해 주세요" 도 없이 사라졌다. 그런데 날
 * 구간은 **소리**에 대한 것이고, 다시 전사해도 소리는 같다 — 구간도 거기 붙은 이름도
 * 여전히 참이다. 남겨 두면:
 *
 * - 파이프라인이 다시 나누면 `saveDiarization` 이 이 판을 옛 판으로 삼아 이름을
 *   **목소리를 따라** 옮긴다. 소리가 같으니 대개 그대로 옮겨지고, 못 옮긴 사람 이름은
 *   "다시 확인" 에 남는다.
 * - 새로 못 나누면(모델이 빠졌거나 워커가 죽었으면) 남겨 둔 구간으로 새 조각에 다시
 *   붙인다 (`reattachStoredDiarization`). 안 붙이면 이름 표만 떠 있고 줄에는 화자가 없다.
 */
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
//   화자 분리
// ─────────────────────────────────────────────────────────────

export function getDiarizationRow(recordingId: string): DiarizationRow | undefined {
  return db
    .select()
    .from(schema.diarizations)
    .where(eq(schema.diarizations.recordingId, recordingId))
    .get();
}

/**
 * 이 판의 **군집 번호가 무엇을 뜻하나**를 가리키는 표지.
 *
 * 이름 표는 "군집 번호 → 이름" 이고 번호의 뜻은 판마다 바뀐다 (k 가 바뀌면 sherpa 가
 * 번호를 새로 매긴다). 화면이 들고 있던 초안이 **어느 판의 번호인가**를 서버가 알아야,
 * 패널을 연 채로 다시 나누기가 끝났을 때 옛 번호의 초안이 새 판에 앉는 것을 막을 수
 * 있다 (`saveHumanDiarNames`).
 *
 * ## `at`(갱신 시각)을 안 쓰는 이유
 *
 * - `updated_at` 은 이름을 저장할 때마다 오른다. 그걸 판으로 쓰면 에이전트가 이름을
 *   붙이기만 해도 사람의 저장이 "다시 나눴습니다" 로 거절된다 — 거짓말이다.
 * - 초 단위다. 같은 초에 두 판이 앉으면 못 가른다.
 *
 * ## 무엇으로 만드나
 *
 * 모델 · 무리 수 · 날 구간의 해시다. 번호의 뜻을 정하는 것이 정확히 그 셋이다. 같은
 * 소리를 같은 k 로 다시 나눠 구간이 한 치도 안 바뀌었으면 표지도 같은데, 그때는 옛
 * 초안의 번호가 새 판에서도 같은 목소리라 저장해도 맞다. 열을 새로 파지 않으니
 * 마이그레이션도 없다.
 */
export function diarRunId(row: Pick<DiarizationRow, "modelId" | "clusters" | "turns">): string {
  return createHash("sha1")
    .update(`${row.modelId}\n${row.clusters}\n${row.turns}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * 화면에 실을 모양. **날 구간은 안 싣는다.**
 *
 * `warnBelow` 는 서술자의 `fileWarnSilhouetteMedian` 이다. 문턱을 화면에
 * 맡기지 않는 이유: 이 눈금은 임베딩 모델마다 다른 값이라, 화면이 손으로 든
 * 숫자를 쓰면 모델을 갈아 끼우는 날 조용히 옛말이 된다.
 */
export function toDiarizationDTO(row: DiarizationRow, warnBelow: number): DiarizationDTO {
  const median = row.silhouetteMedian;
  return {
    modelId: row.modelId,
    roster: readRoster(row.roster),
    clusters: row.clusters,
    found: row.found,
    talkTime: parseTalkTime(row.talkTime),
    names: Object.fromEntries(
      Object.entries(parseNames(row.names)).map(([k, v]) => [String(k), v]),
    ),
    silhouetteMedian: median,
    lowConfidence: median !== null && median <= warnBelow,
    /*
     * 중앙값이 없으면 **재지 못한 것**이다. 이유가 적혀 있지 않은 행(이 칸이
     * 생기기 전에 앉은 것)에도 "못 쟀다" 는 말은 해야 한다 — 이유를 모른다고
     * 사실까지 숨기면 표시가 하나도 없는 녹음이 "잘 갈렸다" 로 읽힌다.
     */
    silhouetteMissing:
      median !== null
        ? null
        : (row.silhouetteNote ?? "화자 분리 엔진이 신뢰도 값을 내지 않았습니다."),
    recheckNames: parseRecheck(row.names),
    at: iso(row.updatedAt),
    run: diarRunId(row),
  };
}

/**
 * 사람이 적어 준 화자 목록을 갈아 끼운다. 다음 판부터 쓰인다.
 *
 * 같은 사람을 두 번 적은 것은 여기서 한 번 더 한 명으로 거른다 (`name-key.ts`).
 * 라우트가 이미 거르지만, 어느 입구로 오든 저장되는 모양은 하나여야 한다.
 */
export function setRoster(recordingId: string, roster: string[]): void {
  db.update(schema.recordings)
    .set({ roster: JSON.stringify(dedupeNames(roster)), updatedAt: new Date() })
    .where(eq(schema.recordings.id, recordingId))
    .run();
}

/**
 * 지금 적혀 있는 목록. **읽을 때도 거른다** — 같음 규칙이 두 벌이던 때 앉은 목록
 * (`["Kim","kim"]`)이 DB 에 남아 있어도, k 를 셀 때는 한 명으로 세어야 한다.
 */
export function getRoster(recordingId: string): string[] {
  const row = getRecordingRow(recordingId);
  return row ? readRoster(row.roster) : [];
}

export interface DiarizationInput {
  recordingId: string;
  modelId: string;
  roster: string[];
  /** 워커에게 준 무리 수 `k`. */
  clusters: number;
  /** 실제로 나온 군집 수. */
  found: number;
  /** 날 구간 + 실루엣. **다시 붙일 때 워커를 다시 안 돌리려고 저장한다.** */
  turns: { s: number; e: number; k: number; sil: number | null }[];
  talkTime: { k: number; seconds: number }[];
  silhouetteMedian: number | null;
  /** 실루엣을 왜 못 쟀나. 쟀으면 null(또는 생략). `schema.ts` 의 `silhouetteNote`. */
  silhouetteNote?: string | null;
  msProcess: number | null;
}

/**
 * 한 판의 결과를 앉힌다. **이름 표는 번호가 아니라 목소리를 따라 옮긴다.**
 *
 * ## 왜 번호 그대로 두면 안 되나
 *
 * 예전에는 이 함수가 `names` 를 안 건드렸다. 그런데 sherpa 의 군집 번호는
 * k 가 바뀌면 뜻이 바뀐다 — 사용자 녹음 한 편(3명)에서 가장 오래 말한 사람이 k=3 에선
 * 1번, k=4·5 에선 2번이다. 목록을 적고 다시 나누면 말한 시간의 45.3% 만 제
 * 이름이었고, 512초 목소리가 2초짜리 부스러기에 붙었던 이름으로 떴다. 사람이
 * 저장한 표였다면 에이전트가 옳은 표를 보내도 고칠 수 없었다(`keptHuman`).
 *
 * ## 어떻게 옮기나
 *
 * 옛 판 구간과 새 판 구간을 **겹친 시간으로** 짝짓는다 (`carryClusters`).
 * 새 군집의 시간이 한 옛 군집에서 뚜렷하게 왔고(순도 ≥ 85%) 그 옛 군집의
 * 과반을 가져갔을 때만 옮긴다. **사람 이름은 하나 더** — 그 옛 군집이 두 목소리로
 * 뚜렷하게 갈라지지 않았어야 한다 (물려받는 군집이 아닌 새 군집들로 간 시간이 15% 미만이고,
 * 8%·20초를 함께 넘지 않아야 한다 — `NAME_CARRY_SPLIT`).
 * 문턱의 근거는 `diarize-assign.ts` 에 있다.
 *
 * - 같은 구간을 다시 붙이는 길은 순도·몫이 100% 라 표가 그대로 남는다 —
 *   예전에 이 함수가 이름을 안 건드리려던 까닭이 그대로 지켜진다. 다시 전사한 뒤
 *   같은 소리를 다시 나누는 길(`clearSegments` 가 이 행을 남긴다)도 여기로 온다.
 * - **사람이 붙인 이름(`~human`)도 같은 규칙으로 옮긴다.** 번호가 아니라 목소리에
 *   붙은 이름이다. 옮기지 못한 사람 이름은 `~recheck` 에 남겨 화면이 "다시 확인해
 *   주세요" 로 띄운다 — 조용히 사라지면 사람은 저장한 이름이 왜 없어졌는지 모른다.
 *   두 목소리가 섞였던 군집의 사람 이름이 다수 목소리로 조용히 가던 길도 이제
 *   여기로 온다 (`NAME_CARRY_SPLIT`).
 * - 에이전트가 붙인 이름은 못 옮기면 버린다. 그 자리는 임시 이름("화자 N")으로 뜨고,
 *   사람이 다음에 다듬기를 누르면 에이전트가 새 번호로 다시 붙인다.
 *   **여기서 다듬기를 다시 돌리지 않는다** — 화자를 나눴다고 전사문 글자가
 *   몰래 다시 다듬어지면 안 된다.
 * - 옮긴 뒤에도 에이전트 이름은 **새 목록 안에서만** 산다 (`agentNameAllowed`).
 *   목록을 고쳐 다시 나눴으면 옛 목록의 이름이 새 목록 밖일 수 있다.
 */
export function saveDiarization(input: DiarizationInput): void {
  const old = getDiarizationRow(input.recordingId);
  const names = old ? carryNames(old, input) : "{}";
  const values = {
    recordingId: input.recordingId,
    modelId: input.modelId,
    roster: JSON.stringify(input.roster),
    clusters: input.clusters,
    found: input.found,
    turns: JSON.stringify(input.turns),
    talkTime: JSON.stringify(input.talkTime),
    silhouetteMedian: input.silhouetteMedian,
    silhouetteNote: input.silhouetteMedian === null ? (input.silhouetteNote ?? null) : null,
    names,
    msProcess: input.msProcess,
  };
  db.insert(schema.diarizations)
    .values(values)
    .onConflictDoUpdate({
      target: schema.diarizations.recordingId,
      set: { ...values, updatedAt: new Date() },
    })
    .run();
}

/**
 * 한 판을 **한 트랜잭션으로** 앉힌다 — 분리 행(이름 옮기기 포함)과 조각마다의 화자.
 *
 * 따로 쓰면 그 사이에 앱이 죽었을 때 새 판의 이름 표가 옛 판의 군집 번호를 단
 * 줄들 옆에 앉는다. 번호의 뜻이 판마다 다르므로 그 짝은 이미 틀린 것이고,
 * 화면에는 그 사실이 안 보인다.
 *
 * @returns 실제로 바뀐 조각 수.
 */
export function commitDiarization(input: DiarizationInput, items: SegmentSpeaker[]): number {
  return db.transaction(() => {
    saveDiarization(input);
    return putSpeakerAssignments(input.recordingId, items);
  });
}

/**
 * 남겨 둔 날 구간으로 **지금 조각에 화자를 다시 붙인다.** 워커를 안 돌린다.
 *
 * 다시 전사한 뒤 화자를 새로 못 나눴을 때 쓴다 (모델 파일이 빠졌거나 워커가 죽었을 때).
 * `clearSegments` 가 분리 행을 남겨 두므로 구간과 이름 표가 있고, 소리가 같으니 그
 * 구간은 새 조각에도 참이다. 안 붙이면 화면에는 목소리 목록과 이름이 떠 있는데 줄에는
 * 화자가 하나도 없는, 서로 어긋난 상태로 남는다.
 *
 * 같은 구간을 다시 앉히는 것이라 이름 표는 `saveDiarization` 의 옮기기를 지나도
 * 그대로다 (순도·몫 100%, 갈라짐 0). 판 표지(`diarRunId`)도 그대로다. 말한 시간만
 * 새 조각 기준으로 다시 센다.
 *
 * ## 붙일 조각이 없으면 **아무것도 안 쓴다**
 *
 * 다시 전사가 조각 0개로 끝나면(말을 하나도 못 옮겼으면) 새로 셀 말한 시간이 비어 있다.
 * 그대로 앉히면 이름 옮기기가 "말한 시간이 있는 군집" 을 하나도 못 찾아, 사람 이름은 전부
 * "다시 확인" 으로 가고 에이전트 이름은 버려진다. 그리고 **뒤에 멀쩡히 다시 전사해도 표가
 * 안 돌아온다** — 그때 옮길 옛 표가 이미 비어 있다. 구간이 새 조각에 하나도 안 걸려 말한
 * 시간이 0 인 경우도 같다. 그래서 그때는 분리 행(말한 시간 · 이름 표 · 다시 확인)을 그대로
 * 두고 null 을 돌려준다. 남겨 둔 판은 소리에 대해 여전히 참이라, 다음에 조각이 생기면
 * 그 조각에 그대로 다시 붙는다.
 *
 * @returns 화자를 붙인 조각 수. 남겨 둔 판이 없거나, 구간이 비었거나, 붙일 조각(말한 시간)이
 *          없어 **아무것도 안 썼으면** null.
 */
export function reattachStoredDiarization(recordingId: string, switchPenalty: number): number | null {
  const row = getDiarizationRow(recordingId);
  if (!row) return null;
  const turns = parseTurns(row.turns);
  if (!turns.length) return null;
  const segments = listSegmentsForAssign(recordingId);
  if (!segments.length) return null;
  const result = assignSpeakers({
    segments,
    turns,
    silhouette: turns.filter((t) => t.sil !== null),
    switchPenalty,
  });
  if (!result.talkTime.some((t) => t.seconds > 0)) return null;
  return commitDiarization(
    {
      recordingId,
      modelId: row.modelId,
      roster: readRoster(row.roster),
      clusters: row.clusters,
      found: row.found,
      turns,
      talkTime: result.talkTime,
      silhouetteMedian: row.silhouetteMedian,
      silhouetteNote: row.silhouetteNote,
      msProcess: row.msProcess,
    },
    result.segments,
  );
}

/**
 * 저장된 날 구간(실루엣 포함). 모양이 어긋난 칸은 버린다 — 이름을 옮길 근거와, 다시
 * 전사한 뒤 다시 붙일 근거로 쓴다. 칸 순서(s·e·k·sil)는 저장할 때와 같게 둔다 —
 * 다시 붙여 저장해도 판 표지(`diarRunId`, 이 JSON 의 해시)가 안 바뀌어야 한다.
 */
function parseTurns(raw: string): { s: number; e: number; k: number; sil: number | null }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const { s, e, k, sil } = v as Record<string, unknown>;
      if (typeof s !== "number" || typeof e !== "number" || typeof k !== "number") return [];
      if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isInteger(k) || e <= s) return [];
      return [{ s, e, k, sil: typeof sil === "number" && Number.isFinite(sil) ? sil : null }];
    });
  } catch {
    return [];
  }
}

/** 옛 판의 이름 표를 새 판으로 옮긴 JSON. `saveDiarization` 의 설명을 보라. */
function carryNames(old: DiarizationRow, input: DiarizationInput): string {
  const oldNames = parseNames(old.names);
  const oldHuman = parseHumanClusters(old.names);
  const recheck = parseRecheck(old.names);

  const plan = carryPlan(parseTurns(old.turns), input.turns);
  const heirOf = new Map<number, number>();
  for (const [nk, ok] of plan.heirs) heirOf.set(ok, nk);

  // 이름이 뜰 자리는 말한 시간이 있는 군집뿐이다 (`knownNames` 와 같은 문).
  const known = new Set(input.talkTime.map((t) => t.k));
  const rank = new Map(input.talkTime.map((t, i) => [t.k, i]));

  const names: Record<string, string> = {};
  const human: number[] = [];
  for (const [okStr, name] of Object.entries(oldNames)) {
    const ok = Number(okStr);
    const nk = heirOf.get(ok);
    const isHuman = oldHuman.has(ok);
    if (nk === undefined || !known.has(nk)) {
      if (isHuman) recheck.push(name);
      continue;
    }
    if (isHuman) {
      /*
       * 두 목소리가 섞였던 옛 군집이 둘로 갈라졌다. 사람은 그 줄들 가운데 **소수 목소리**의
       * 대사를 보고 이름을 붙였을 수 있고, 소리는 어느 쪽이었는지 말해 주지 않는다. 다수
       * 목소리로 옮기면 그 이름이 `~human` 으로 잠긴 채 남의 목소리에 굳는다 — 에이전트가
       * 옳은 표를 보내도 못 고친다. 그래서 "다시 확인" 으로 돌린다 (`NAME_CARRY_SPLIT`).
       */
      if (plan.split.has(ok)) {
        recheck.push(name);
        continue;
      }
      names[String(nk)] = name;
      human.push(nk);
      continue;
    }
    const allowed = agentNameAllowed(name, input.roster, rank.get(nk) ?? Infinity);
    if (allowed) names[String(nk)] = allowed;
  }

  // 자리를 찾은 사람 이름은 "다시 확인" 에서 뺀다. 같은 이름이 둘 다에 있으면 헷갈린다.
  const placed = new Set(human.map((k) => nameKey(names[String(k)])));
  return namesDoc(names, human, recheck.filter((n) => !placed.has(nameKey(n))));
}

/**
 * 이름 표 JSON 안에서 **사람이 정한 군집 번호**를 적어 두는 칸.
 *
 * 열이 아니라 같은 JSON 의 한 칸인 이유: 이름과 "누가 정했나" 는 늘 함께
 * 바뀌고 함께 읽힌다. 따로 두면 한쪽만 고치는 날이 온다. 열쇠가 숫자가
 * 아니므로 `parseNames` 는 이 칸을 건너뛰고, 화면(`toDiarizationDTO`)에도
 * 실리지 않는다.
 */
const HUMAN_NAMES_KEY = "~human";

/**
 * 같은 JSON 안의 또 한 칸 — **다시 나누며 옮기지 못한 사람 이름.**
 *
 * `~human` 과 같은 이유로 열이 아니라 여기 산다: 이름 표와 늘 함께 바뀐다.
 * 숫자 열쇠가 아니라 `parseNames` 가 건너뛴다.
 */
const RECHECK_NAMES_KEY = "~recheck";

function parseHumanClusters(raw: string): Set<number> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const list = (parsed as Record<string, unknown>)[HUMAN_NAMES_KEY];
    if (!Array.isArray(list)) return new Set();
    return new Set(list.filter((v): v is number => Number.isInteger(v)));
  } catch {
    return new Set();
  }
}

function parseRecheck(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const list = (parsed as Record<string, unknown>)[RECHECK_NAMES_KEY];
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
  } catch {
    return [];
  }
}

function namesDoc(names: Record<string, string>, human: Iterable<number>, recheck: string[]): string {
  const doc: Record<string, unknown> = { ...names };
  const h = [...new Set(human)].filter((k) => names[String(k)] !== undefined).sort((a, b) => a - b);
  if (h.length) doc[HUMAN_NAMES_KEY] = h;
  const r = [...new Set(recheck)];
  if (r.length) doc[RECHECK_NAMES_KEY] = r;
  return JSON.stringify(doc);
}

function writeNames(recordingId: string, doc: string): void {
  db.update(schema.diarizations)
    .set({ names: doc, updatedAt: new Date() })
    .where(eq(schema.diarizations.recordingId, recordingId))
    .run();
}

/**
 * 에이전트가 이 군집에 이 이름을 붙여도 되나. 되면 **목록에 적힌 철자**를 돌려준다.
 *
 * ## 닫힌 집합이다 — 안내문이 아니라 코드로 막는다
 *
 * 목록이 있으면 이름은 **목록의 이름 중 하나**여야 한다. 안내문("그 안에서
 * 고른다")만으로는 모델이 전사문에서 주운 다른 이름이나 지어낸 이름을 낼 때
 * 막을 길이 없고, 그 이름은 화면에서 사람이 정한 이름과 똑같이 보인다.
 * 목록 밖이면 버린다 — 버리면 임시 이름이 남을 뿐이라 언제나 안전한 실패다.
 *
 * **말한 시간 상위 L개 밖의 군집(`ranked=false`)은 무엇을 보내든 `other` 다.**
 * 그 자리는 기침·웃음·겹쳐 말한 부스러기이고, 이름을 주는 규칙(상위 L개)은
 * 신탁과 0.1pt 이내다. 에이전트가 거기 사람 이름을 달면 그 규칙이 깨진다.
 *
 * 목록이 비어 있으면(분리 기능이 생기기 전 판) 모든 군집이 이름 자리이고
 * 이름을 가를 목록도 없으므로 거르지 않는다.
 *
 * 사람이 붙이는 이름(`setDiarNames`)에는 이 문을 걸지 않는다 — 목록에서 빠뜨린
 * 사람이 "목록 밖" 군집에 앉아 있을 수 있고, 그걸 아는 것은 사람뿐이다.
 */
function agentNameAllowed(name: string, roster: string[], rank: number): string | null {
  if (!roster.length) return name;
  if (!(rank < roster.length)) return null;
  const key = nameKey(name);
  return roster.find((r) => nameKey(r) === key) ?? null;
}

/**
 * 군집 → 이름 표를 **사람이** 채운다 (`…/speakers` 라우트).
 *
 * ## **실제로 바뀐 이름만** 사람의 것으로 적는다
 *
 * 화면은 표 전체를 초안으로 들고 있다가 통째로 보낸다. 예전에는 받은 표의
 * **모든** 이름을 사람의 것(`~human`)으로 적었다 — 한 이름만 고쳐도 에이전트가
 * 붙인 나머지까지 사람 것으로 잠겨, 다음 다듬기가 잘못 짚은 이름을 고칠 수
 * 없었다. 그래서 지금 값과 견줘 **다른 것만** 사람의 것으로 적는다. 화면이
 * 바뀐 것만 보내게 하는 것보다 서버가 견주는 편이 안전하다 — 어느 화면이
 * 부르든 같은 규칙이 걸린다.
 *
 * - 안 온 번호 · 지금과 같은 이름 → 그대로 둔다 (누가 정했나도 그대로).
 * - 다른 이름 → 그 이름으로, 사람의 것으로.
 * - 빈 이름 → 지운다. 임시 이름으로 돌아가고 사람의 것 표시도 뗀다.
 *
 * ## "다시 확인해 주세요" 에서는 **사람이 다룬 이름만** 뺀다
 *
 * 예전에는 저장하면 `~recheck` 를 통째로 비웠다. 그러면 상관없는 이름 하나만 고쳐
 * 저장해도 옮기지 못한 다른 사람 이름들이 흔적 없이 사라졌다 — 사람은 그 이름들을
 * 본 적도, 다룬 적도 없다. 그래서 뺄 것은 둘뿐이다:
 *
 * - 사람이 **표에 그 이름을 붙였다** (보낸 칸 가운데 그 이름이 있다).
 * - 사람이 **명시적으로 지웠다** — 칸을 비워 그 이름을 떼었거나, 화면의 "다시 확인"
 *   목록에서 그 이름을 뺐다(`dismissRecheck`).
 *
 * 이름의 같음은 `nameKey` 로 본다 (대소문자·조합형 차이는 같은 이름).
 *
 * 줄마다의 화자를 받는 자리는 없앴다 (`applyPolish` 의 설명). 이 함수는
 * **아는 번호만** 남기는 마지막 문이다.
 *
 * ## 판을 안 본다 — 라우트는 이것을 안 쓴다
 *
 * 여기는 번호가 **지금 판의 번호**라는 것을 부르는 쪽이 이미 아는 자리(시험, 같은
 * 트랜잭션 안)만 쓴다. 사람의 화면에서 오는 저장은 `saveHumanDiarNames` 로 간다 —
 * 초안이 옛 판의 번호일 수 있기 때문이다.
 */
export function setDiarNames(
  recordingId: string,
  names: Record<number, string>,
  dismissRecheck: string[] = [],
): boolean {
  const row = getDiarizationRow(recordingId);
  if (!row) return false;
  writeNames(recordingId, humanNamesDoc(row, names, dismissRecheck));
  return true;
}

/** `saveHumanDiarNames` 의 결과. 라우트가 그대로 상태 코드로 옮긴다. */
export type HumanNamesResult = "saved" | "no-diarization" | "stale";

/**
 * 사람의 화면에서 온 이름 표를 **판을 확인하고** 앉힌다 (`PATCH …/speakers`).
 *
 * ## 왜 판을 보나 — 패널을 연 채로 다시 나누기가 끝나는 길
 *
 * 화자 패널은 분리가 도는 동안에도 열리고 화면은 몇 초마다 상세를 다시 받는다. 목록
 * [가] 로 k=3 에서 초안 {0:나, 1:가} 를 들고 있는데, 목록 3명으로 다시
 * 나눈 k=5 가 끝나면 서버는 옳게 {2:가} 로 옮겨 둔다. 그 위에 옛 초안이 그대로
 * 오면 `1:가` 는 k=5 에서 **화자 다의 목소리**다 — 이 함수가 그 이름을 "사람이
 * 바꾼 것" 으로 받아 `~human` 으로 잠그고(에이전트가 옳은 표를 보내도 `keptHuman`),
 * 한 이름이 두 목소리에 앉는다. 이름을 목소리를 따라 옮겨 둔 것이 화면 한 번의 저장으로
 * 되돌아간다.
 *
 * 화면만 고치면 다른 화면이나 옛 탭이 같은 일을 한다. 그래서 **서버가 막는다**: 초안이
 * 어느 판의 번호인지(`run`, `diarRunId`)를 함께 받고, 지금 판과 다르면 아무것도 안
 * 쓰고 `"stale"` 을 돌려준다. 화면은 새 판으로 초안을 다시 맞추고 사람에게 말한다.
 *
 * 확인과 쓰기 사이에 다른 판이 끼어들 틈은 없다 — 둘 다 같은 동기 호출 안이고, 분리
 * 결과를 앉히는 쪽(`commitDiarization`)도 동기라 이 함수 도중에 돌 수 없다.
 */
export function saveHumanDiarNames(
  recordingId: string,
  input: { run: string; names: Record<number, string>; dismissRecheck?: string[] },
): HumanNamesResult {
  const row = getDiarizationRow(recordingId);
  if (!row) return "no-diarization";
  if (diarRunId(row) !== input.run) return "stale";
  writeNames(recordingId, humanNamesDoc(row, input.names, input.dismissRecheck ?? []));
  return "saved";
}

/** 사람이 보낸 표를 지금 표에 얹은 JSON. `setDiarNames` 의 규칙. */
function humanNamesDoc(
  row: DiarizationRow,
  names: Record<number, string>,
  dismissRecheck: string[],
): string {
  const known = new Set(parseTalkTime(row.talkTime).map((t) => t.k));
  const before = parseNames(row.names);
  const out: Record<string, string> = {};
  const human = new Set<number>();
  for (const [k, v] of Object.entries(before)) {
    const n = Number(k);
    if (!known.has(n)) continue;
    out[String(n)] = v;
  }
  for (const k of parseHumanClusters(row.names)) if (known.has(k)) human.add(k);

  /** 사람이 이번 저장에서 **다룬** 이름들의 열쇠. 이것만 "다시 확인" 에서 뺀다. */
  const handled = new Set(dismissRecheck.map(nameKey));

  for (const [k, v] of Object.entries(names)) {
    const n = Number(k);
    // 없는 군집에 붙은 이름은 버린다. 화면에 뜰 자리가 없고, 뜬다면 그게 더 나쁘다.
    if (!Number.isInteger(n) || !known.has(n)) continue;
    // 보이지 않는 형식 문자는 보이는 철자에서도 뗀다 (`cleanName`) — 목록 쪽과 같은 규칙.
    const next = cleanName(v);
    const prev = (before[n] ?? "").trim();
    // 칸에 이름을 적어 보냈으면(지금과 같아도) 그 이름을 다룬 것이고, 비워 보냈으면 떼어 낸 이름을 다룬 것이다.
    if (next) handled.add(nameKey(next));
    else if (prev) handled.add(nameKey(prev));
    if (next === prev) continue;
    if (next) {
      out[String(n)] = next;
      human.add(n);
    } else {
      delete out[String(n)];
      human.delete(n);
    }
  }
  const recheck = parseRecheck(row.names).filter((name) => !handled.has(nameKey(name)));
  return namesDoc(out, human, recheck);
}

/**
 * 군집 → 이름 표를 **에이전트가** 채운다. **에이전트가 돌려주는 유일한 화자 값이다.**
 *
 * ## 사람이 정한 이름은 **안 덮는다**
 *
 * `applyPolish` 가 `edited` 줄을 건너뛰는 것과 같은 규율이다. 다시 다듬을
 * 때마다 에이전트의 판단이 사람의 판단을 덮으면, 사람은 고친 이름이 왜
 * 되돌아갔는지 알 길이 없고 결국 고치기를 그만둔다.
 *
 * ## 에이전트의 몫은 **통째로 갈아 끼운다**
 *
 * 온 것만 얹고 앞선 판의 에이전트 이름을 남기면, 잘못 짚은 이름을 고칠 길이
 * 없다 — 안내문은 "근거가 없으면 비워 둬라" 고 시키는데, 비운 것이 옛 이름을
 * 지우지 못하면 그 지시가 뜻을 잃는다. 한 판의 답은 그 판 전체에 대한 판단이다.
 *
 * 여기 오는 것은 남이 만든 소리에서 나온 글을 읽은 모델의 출력이므로 부르는
 * 쪽(`agent.ts` 의 `readSpeakerNames`)이 먼저 거르고, 여기서 **목록이라는 닫힌
 * 집합**으로 한 번 더 거른다 (`agentNameAllowed`).
 *
 * ## 보낸 판과 지금 판이 다르면 **아무것도 안 쓴다** (`sentRun`)
 *
 * 에이전트는 다듬기를 보낼 때의 전사문에 찍힌 군집 번호(`S0`, `S1` …)로 이름을 붙인다.
 * 그 사이에 화자를 다시 나눴으면 번호의 뜻이 바뀌어, 옛 번호의 이름이 새 판의 **다른
 * 목소리**에 앉는다. 사람의 저장(`saveHumanDiarNames`)이 판을 확인하는 것과 같은 결이다.
 *
 * 옮기지 않고 **버린다.** 옮기기 규칙(`carryPlan`)은 옛 판의 날 구간이 있어야 도는데, 분리
 * 행은 판마다 덮여 보낼 때의 구간이 남아 있지 않다 — 표지(`diarRunId`, 해시)만으로는 옮길
 * 수 없다. 에이전트 이름은 잠기지 않는 이름이라 버려도 다음 다듬기가 새 번호로 다시 붙이고,
 * 그 사실은 부르는 쪽이 사람에게 말한다 (`stale`). 사람 이름·"다시 확인" 은 원래 안 건드린다.
 *
 * `sentRun` 을 안 주면(`undefined`) 판을 안 본다 — 번호가 지금 판의 것임을 부르는 쪽이 이미
 * 아는 자리(시험)다. `null` 은 "보낼 때 분리가 없었다" 는 뜻이라 지금 판이 있으면 다른 판이다.
 *
 * @returns 앉힌 에이전트 이름 수, 사람의 것이라 건드리지 않은 이름 수, 목록 밖이거나
 *          이름 자리가 아니라 버린 수, 판이 달라 통째로 버렸나. 분리를 안 한 녹음이면 null.
 */
export function setAgentDiarNames(
  recordingId: string,
  names: Record<number, string>,
  sentRun?: string | null,
): { applied: number; keptHuman: number; rejected: number; stale: boolean } | null {
  const row = getDiarizationRow(recordingId);
  if (!row) return null;
  const talk = parseTalkTime(row.talkTime);
  const known = new Set(talk.map((t) => t.k));
  const rank = new Map(talk.map((t, i) => [t.k, i]));
  const roster = readRoster(row.roster);
  const before = parseNames(row.names);
  const human = [...parseHumanClusters(row.names)].filter((k) => known.has(k) && before[k]);
  if (sentRun !== undefined && sentRun !== diarRunId(row)) {
    return { applied: 0, keptHuman: human.length, rejected: 0, stale: true };
  }

  const out: Record<string, string> = {};
  for (const k of human) out[String(k)] = before[k];
  let applied = 0;
  let rejected = 0;
  for (const [k, v] of Object.entries(names)) {
    const n = Number(k);
    if (!Number.isInteger(n) || !known.has(n)) continue;
    if (human.includes(n)) continue;
    const name = cleanName(v);
    if (!name) continue;
    const allowed = agentNameAllowed(name, roster, rank.get(n) ?? Infinity);
    if (!allowed) {
      rejected += 1;
      continue;
    }
    out[String(n)] = allowed;
    applied += 1;
  }
  // 에이전트 판은 사람의 "다시 확인" 목록을 건드리지 않는다. 사람이 볼 때까지 남는다.
  writeNames(recordingId, namesDoc(out, human, parseRecheck(row.names)));
  return { applied, keptHuman: human.length, rejected, stale: false };
}

export function clearDiarization(recordingId: string): void {
  db.delete(schema.diarizations)
    .where(eq(schema.diarizations.recordingId, recordingId))
    .run();
  db.update(schema.segments)
    .set({
      speakerCluster: null,
      speakerRuns: "[]",
      speakerSil: null,
      // `human` 은 사람의 것이라 안 지운다. 지우는 것은 소리가 붙인 것뿐이다.
      speakerSource: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.segments.recordingId, recordingId),
        eq(schema.segments.speakerSource, "acoustic"),
      ),
    )
    .run();
}

/**
 * 소리로 가른 결과를 조각에 앉힌다. **줄을 새로 만들지 않는다.**
 *
 * 한 트랜잭션이다. 조각 1,150개(AMI 한 편)면 UPDATE 가 그만큼 도는데, 중간에
 * 끊기면 앞쪽 줄만 새 화자를 달고 뒤쪽은 옛것으로 남는다 — 한 전사문 안에서
 * 두 근거가 섞이는 상태이고, 화면에는 그 사실이 안 보인다.
 *
 * **사람이 손으로 고친 줄은 건너뛴다.** 조건을 SQL 에 걸어 두면 빠뜨릴 길이
 * 없다 — `applyPolish` 와 같은 규율이다. 사람의 화자로 치는 줄은 둘이다:
 *
 * - `speakerSource = 'human'` — 이 판의 코드가 사람이 고친 줄에 찍는 값.
 * - `edited = 1` 인데 근거가 `agent-guess` 인 줄 — 근거 칸이 생기기 전(0001)에
 *   사람이 화자를 고친 흔적은 `edited` 하나로만 남는다. 마이그레이션이 그런 줄을
 *   `human` 으로 찍지만, 그 문 하나에만 기대면 거기를 누가 고치는 날 사람이 적은
 *   이름이 소리로 덮이고 화면에서 사라진다(`toSegmentDTO` 가 풀어낸 이름을
 *   앞세운다). 그래서 여기서도 한 번 더 막는다. 글만 고친 줄일 수도 있지만 그쪽
 *   으로 틀리면 옛 이름이 **보이는 채로** 남는다.
 *
 * 소리가 이미 붙인 줄(`acoustic`)은 글을 고쳤어도 다시 붙인다 — 글을 고친 것은
 * 화자에 대한 판단이 아니다.
 */
export function putSpeakerAssignments(
  recordingId: string,
  items: SegmentSpeaker[],
): number {
  let changed = 0;
  const now = new Date();
  db.transaction((tx) => {
    for (const item of items) {
      const r = tx
        .update(schema.segments)
        .set({
          speakerCluster: item.cluster,
          speakerRuns: JSON.stringify(compactRuns(item.runs)),
          speakerSil: item.sil,
          speakerSource: "acoustic",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.segments.recordingId, recordingId),
            eq(schema.segments.idx, item.idx),
            or(
              and(
                isNull(schema.segments.speakerSource),
                or(isNull(schema.segments.speaker), eq(schema.segments.edited, 0)),
              ),
              eq(schema.segments.speakerSource, "acoustic"),
              and(
                eq(schema.segments.speakerSource, "agent-guess"),
                eq(schema.segments.edited, 0),
              ),
            ),
          ),
        )
        .run();
      changed += r.changes;
    }
  });
  return changed;
}

/**
 * 토막 하나가 조각 전체일 때는 **저장하지 않는다.**
 *
 * 이 경우가 다수다 (AMI 에서 조각 1,150개에 토막 1,131개 — 대부분 한 줄에
 * 한 사람이다). 그때 `speakerCluster` 하나면 같은 말을 다 한 것이고, 토막
 * 목록은 같은 값을 JSON 으로 한 번 더 적은 것뿐이다.
 */
function compactRuns(runs: SpeakerRun[]): SpeakerRun[] {
  return runs.length <= 1 ? [] : runs;
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
