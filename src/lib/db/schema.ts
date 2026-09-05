import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/*
 * 열거값은 여기 한 곳에 두고 화면과 zod 검증이 함께 가져다 쓴다.
 * 두 벌로 두면 한쪽만 늘어나는 날이 반드시 온다 (형제 앱들의 관례).
 */

/**
 * 녹음 한 건이 지나가는 자리.
 *
 * `types.ts` 의 `JobState` 와 **같은 값이어야 한다.** 저쪽은 계약이라 못을
 * 박아 두었고 여기는 DB 의 CHECK 로 쓰인다. 늘리려면 둘을 함께 고쳐야 한다.
 */
export const JOB_STATES = [
  "queued",
  "extracting",
  "transcribing",
  "polishing",
  "done",
  "failed",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 요약을 누가 썼나. 사람이 손대면 그때부터 사람의 글이다. */
export const SUMMARY_SOURCES = ["human", "agent"] as const;
export type SummarySource = (typeof SUMMARY_SOURCES)[number];

/** 에이전트에 맡긴 일이 지금 어디쯤인가. */
export const RUN_STATES = ["running", "done", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];

const stamp = (name: string) =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);

// ─────────────────────────────────────────────────────────────
//   녹음
// ─────────────────────────────────────────────────────────────

/**
 * 올린 소리(또는 영상) 한 건.
 *
 * **바이트는 여기 없다.** 파일은 MemoBento 의 예약 메모함에 살고 이 행은
 * `file_id` 만 들고 있다. 재생은 그쪽으로 프록시하고, 다시 전사할 때도
 * 그쪽에서 받아 온다. 저장소를 둘로 나누면 지운 파일과 남은 행이 어긋나는
 * 자리가 생기는데, 손잡이가 하나면 그럴 일이 없다.
 */
export const recordings = sqliteTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),

    /** MemoBento 파일 id. 파일을 못 올렸으면 null 이고, 그때는 전사도 못 한다. */
    fileId: text("file_id"),
    /** 올린 원본 이름. 확장자가 영상인지 소리인지 가르는 데도 쓴다. */
    sourceName: text("source_name").notNull().default(""),
    /** 원본 바이트 수. 표시용. */
    sourceSize: integer("source_size").notNull().default(0),

    /**
     * 초. 정규화한 WAV 의 표본 수에서 나온 **정확한** 값이다.
     * ffprobe 를 넣지 않은 이유가 이것이다 — 어차피 다음 단계에서 정확히 안다.
     * 전사 전에는 null.
     */
    duration: real("duration"),

    state: text("state", { enum: JOB_STATES }).notNull().default("queued"),
    /** 0~1. 처리한 조각 시간 / 전체 길이. 도는 중일 때만 뜻이 있다. */
    progress: real("progress"),
    /** 실패했다면 사람이 읽을 이유. 조용히 빈 값으로 끝내지 않는다. */
    error: text("error"),

    /**
     * 전사를 몇 번 시작했나.
     *
     * 컨테이너가 다시 뜨면 도는 중이던 것을 되살리는데, 워커를 넘어뜨리는
     * 파일이 하나 있으면 그 되살리기가 무한 고리가 된다 (죽고 → 다시 뜨고 →
     * 되살리고 → 죽고). 이 값으로 두 번까지만 되살린다.
     * `lib/transcribe.ts` 의 `recoverStaleJobs()` 를 보라.
     */
    attempts: integer("attempts").notNull().default(0),

    /**
     * 서버가 알아챈 것. 화면이 그대로 띄운다.
     *
     * 지금 여기 담기는 것은 거의 하나다 — **이 모델은 한국어를 못 한다.**
     * 소리는 긴데 나온 글이 거의 없으면 십중팔구 그것이고, 그 사실을 말해
     * 주지 않으면 사람은 파일이 잘못된 줄 알고 같은 것을 다시 올린다.
     * 모양은 `types.ts` 의 `RecordingNoticeDTO` JSON.
     */
    notice: text("notice"),

    /**
     * 다듬기(에이전트)의 작업 번호와 실패 이유.
     *
     * 표 하나를 더 파지 않은 것은 녹음 하나에 도는 다듬기가 늘 하나뿐이기
     * 때문이다. 진행 상태는 `state === "polishing"` 이 말해 준다.
     */
    polishJobId: text("polish_job_id"),
    polishError: text("polish_error"),
    /** 다듬기를 시작한 때. 기한을 넘겼는지 여기서 잰다. */
    polishStartedAt: integer("polish_started_at", { mode: "timestamp" }),

    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => ({
    /** 목록은 늘 최신순이다. */
    byCreated: index("recordings_created_idx").on(t.createdAt),
    /** 다시 떴을 때 도는 중이던 것을 찾는 길. */
    byState: index("recordings_state_idx").on(t.state),
  }),
);

export type RecordingRow = typeof recordings.$inferSelect;

// ─────────────────────────────────────────────────────────────
//   조각 — VAD 가 자른 한 토막
// ─────────────────────────────────────────────────────────────

/**
 * 전사문 한 줄.
 *
 * **조각 하나가 끝날 때마다 여기 한 줄이 앉는다.** 통째로 모아 두었다가 끝에
 * 한 번에 쓰지 않는다 — 한 시간짜리가 55분째에 죽으면 그때까지의 55분이
 * 통째로 사라진다. 워커가 죽어도 여기까지는 남는다.
 *
 * `raw` 와 `text` 를 나눠 둔 이유: 에이전트가 다듬거나 사람이 고치면 `text` 만
 * 바뀐다. `raw` 는 모델이 실제로 들은 것이라 되돌리기의 기준이고, 다듬기가
 * 이상하게 나왔을 때 "모델이 잘못 들은 것인지 에이전트가 지어낸 것인지" 를
 * 가르는 유일한 자리다. 절대 덮어쓰지 않는다.
 */
export const segments = sqliteTable(
  "segments",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),

    /** 0부터. 시간순이고, 에이전트에게 넘길 때의 `i` 가 이 값이다. */
    idx: integer("idx").notNull(),

    /**
     * 전체 기준 초.
     *
     * VAD 조각의 시작이라 `absTs = seg.start / sampleRate + relTs` 로 옮겨
     * 앉힌 값이다. 실측 오차는 조각 경계 ±25ms — 줄을 눌러 그 시각으로
     * 뛰는 데는 넘치게 정확하다.
     */
    start: real("start").notNull(),
    end: real("end").notNull(),

    /** 모델이 들은 그대로. */
    raw: text("raw").notNull().default(""),
    /** 사람이 읽는 글. 처음에는 `raw` 와 같다. */
    text: text("text").notNull().default(""),

    /** 에이전트가 대사에서 추정한 화자. 화자 분리 모델은 쓰지 않는다. */
    speaker: text("speaker"),

    /**
     * 낱말별 시각. `[{ w, t }]` JSON.
     *
     * 모델이 주는 `words` 는 **늘 비어 있다.** 토큰과 시각만 오고
     * (SentencePiece 라 낱말 첫 토큰에만 앞 공백이 붙는다) 낱말은 워커가
     * 직접 묶는다 — `scripts/transcribe.mjs` 의 `groupWords()`.
     */
    words: text("words").notNull().default("[]"),

    /**
     * 사람이 고쳤나.
     *
     * 1 이면 다시 다듬어도 이 줄은 안 덮는다. 사람이 고친 글을 기계가 되돌리는
     * 것은 되돌릴 수 없는 손해다 — 모델이 잘못 들은 것은 `raw` 에 남아 있지만
     * 사람이 고쳐 쓴 문장은 어디에도 없다.
     */
    edited: integer("edited").notNull().default(0),

    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => ({
    /**
     * 같은 자리에 두 줄이 앉지 못하게 — 그리고 **읽는 길도 이것 하나로 충분하다.**
     *
     * 목록은 늘 `where recording_id = ? order by idx` 로 읽는데, 유일 색인이
     * 이미 그 순서로 서 있다. 같은 두 칸에 색인을 하나 더 만들면 INSERT 마다
     * 두 번 쓰기만 하고 얻는 것이 없다.
     *
     * 유일해야 하는 이유: 워커가 다시 살아나 같은 조각을 또 보낼 수 있다.
     * 그때 `putSegment` 의 `onConflictDoUpdate` 가 걸리려면 여기 제약이 있어야
     * 한다 — 없으면 같은 자리에 두 줄이 앉아 전사문이 두 번 읽힌다.
     */
    uniqueIdx: uniqueIndex("segments_recording_idx_uq").on(t.recordingId, t.idx),
  }),
);

export type SegmentRow = typeof segments.$inferSelect;

// ─────────────────────────────────────────────────────────────
//   요약
// ─────────────────────────────────────────────────────────────

/**
 * 녹음 하나에 요약 하나.
 *
 * 도는 중인 작업 상태도 여기 함께 산다 (`state`·`jobId`). 표를 하나 더 파지
 * 않은 것은 녹음 하나에 도는 요약이 늘 하나뿐이라서다 — 새로 만들면 앞의
 * 것을 대신한다.
 */
export const summaries = sqliteTable("summaries", {
  recordingId: text("recording_id")
    .primaryKey()
    .references(() => recordings.id, { onDelete: "cascade" }),

  body: text("body").notNull().default(""),
  source: text("source", { enum: SUMMARY_SOURCES }).notNull().default("human"),
  /** 에이전트에게 무엇을 시켰는지. 나중에 "왜 이렇게 나왔지" 를 되짚는 자리. */
  instruction: text("instruction"),

  /** 도는 중인 요약이 있으면 그 상태. 없으면 null. */
  state: text("state", { enum: RUN_STATES }),
  jobId: text("job_id"),
  error: text("error"),
  /** 기한을 넘겼는지 재는 자리. */
  startedAt: integer("started_at", { mode: "timestamp" }),

  createdAt: stamp("created_at"),
  updatedAt: stamp("updated_at"),
});

export type SummaryRow = typeof summaries.$inferSelect;

// ─────────────────────────────────────────────────────────────
//   인프라 — 도메인과 무관
// ─────────────────────────────────────────────────────────────

/**
 * 에이전트 활동 기록. 형제 앱들과 같은 모양이다.
 *
 * 밖에서(MCP·봇) 들어온 변경만 남는다. 사람이 화면에서 한 일은 화면에
 * 보이지만, 에이전트가 한 일은 결과만 남고 누가 왜 했는지가 사라진다.
 */
export const agentLog = sqliteTable("agent_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: stamp("at"),
  actor: text("actor").notNull().default("agent"),
  action: text("action").notNull(),
  target: text("target"),
  detail: text("detail"),
});

export type AgentLogRow = typeof agentLog.$inferSelect;

/** 로그인 기록 — 넣기만 한다. 지우는 입구는 일부러 없다. */
export const loginLog = sqliteTable("login_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: stamp("at"),
  type: text("type", { enum: ["manual", "auto"] }).notNull(),
  success: integer("success").notNull().default(0),
  userAgent: text("user_agent"),
});

/**
 * 한 줄짜리 설정. 늘 id=1 한 행이다.
 *
 * `settings` 는 **설정 한 덩어리가 든 JSON 자루**다 (`lib/app-config.ts` 의
 * `Settings`). 칸을 파지 않은 것은 자루 안을 넓히는 데 마이그레이션 번호가
 * 필요 없기 때문이고, 대신 읽는 쪽은 늘 **깨져 있을 것을 전제로** 읽는다.
 */
export const appConfig = sqliteTable("app_config", {
  id: integer("id").primaryKey().default(1),
  /**
   * 전사가 끝나면 곧바로 다듬기까지 갈지. 기본 켬.
   *
   * 사람이 원한 것은 "올리면 전사문이 나온다" 이지 "올리고 나서 버튼을 한 번
   * 더 누른다" 가 아니다. 에이전트가 설정되어 있지 않으면 이 값과 무관하게
   * 전사까지만 하고 멈춘다.
   */
  autoPolish: integer("auto_polish").notNull().default(1),
  settings: text("settings"),
  updatedAt: stamp("updated_at"),
});

export type AppConfigRow = typeof appConfig.$inferSelect;
