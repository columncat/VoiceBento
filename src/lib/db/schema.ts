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
  /**
   * 소리를 들어 화자를 가르는 중. **전사문은 이 단계에서 이미 온전하다.**
   *
   * `transcribing` 에 숨기지 않는 이유: 60분짜리면 여기서 7~9분이 더 걸린다
   * (RTF 0.12~0.28). 그동안 "전사 중" 이라고 적어 두면 진행 막대가 멎은 채로
   * 몇 분이 흐르고, 화면이 거짓말을 하는 것이 된다. 단계 이름은 값이 싸다.
   */
  "diarizing",
  "polishing",
  "done",
  "failed",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * 화자 분리가 어디까지 갔나. **`state` 와 별개다 — 그것이 요점이다.**
 *
 * 분리가 어떻게 실패하든 전사문은 온전하고 `state` 는 `done` 이어야 한다.
 * 그래서 실패는 `recordings.state` 가 아니라 여기 앉는다.
 *
 * - `none`    — 아직 안 했다 (옛 녹음, 또는 전사만 끝난 것).
 * - `running` — 워커가 도는 중. 다시 뜨면 **실패로 접고 다시 안 돌린다.**
 * - `done`    — 붙었다.
 * - `failed`  — 못 붙였다. 이유는 `speakerError`.
 * - `skipped` — 안 했다 (길이 상한을 넘었다 등). 거절이 아니라 건너뛴 것이다.
 */
export const SPEAKER_STATES = ["none", "running", "done", "failed", "skipped"] as const;
export type SpeakerState = (typeof SPEAKER_STATES)[number];

/**
 * 이 줄의 화자를 **누가 정했나.**
 *
 * - `agent-guess` — 에이전트가 대사에서 추정했다. **소리를 안 들었다.**
 *   화자 분리를 붙이기 전의 모든 줄이 이것이고, 마이그레이션이 그렇게 찍는다.
 * - `acoustic`    — 소리로 갈랐다 (`speakerCluster`·`speakerRuns`).
 * - `human`       — 사람이 손으로 고쳤다. 아무것도 이 위를 덮지 않는다.
 *
 * 이 칸이 없으면 옛 녹음의 추정 화자와 새로 소리로 가른 화자가 화면에서
 * 똑같이 생긴 이름으로 앉는다. 근거가 다른 두 값을 같은 얼굴로 보여 주면
 * 사람은 둘 다 같은 무게로 믿는다.
 */
export const SPEAKER_SOURCES = ["agent-guess", "acoustic", "human"] as const;
export type SpeakerSource = (typeof SPEAKER_SOURCES)[number];

/** 요약을 누가 썼나. 사람이 손대면 그때부터 사람의 글이다. */
export const SUMMARY_SOURCES = ["human", "agent"] as const;
export type SummarySource = (typeof SUMMARY_SOURCES)[number];

/** 에이전트에 맡긴 일이 지금 어디쯤인가. */
export const RUN_STATES = ["running", "done", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * 다듬기가 한 줄에 붙일 수 있는 표시.
 *
 * `lib/asr-models.ts` 의 `SEGMENT_FLAGS` 와 **같은 값이어야 한다.** 저쪽이
 * 계약(에이전트에게 시키는 말과 허용목록)이고 여기는 drizzle 의 타입이다.
 * 늘리려면 둘을 함께 고쳐야 한다 — `JOB_STATES` 와 같은 관례다.
 *
 * SQLite 쪽에 CHECK 를 걸지 않는 것은 형제 칸(`state`·`source`)과 맞추려는
 * 것이다. 걸러 내는 문은 `lib/agent.ts` 의 허용목록 하나이고, 그 문이
 * 열리는 날 DB 가 대신 막아 주는 것보다 **한 조각이 아니라 다듬기 전체가
 * 트랜잭션째 날아가는 쪽**이 더 나쁘다.
 */
export const SEGMENT_FLAGS = [
  "other-language",
  "hallucinated",
  "unclear",
  "cut-off",
] as const;
export type SegmentFlag = (typeof SEGMENT_FLAGS)[number];

const stamp = (name: string) =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);

// ─────────────────────────────────────────────────────────────
//   세션 — 녹음 여럿이 한 맥락을 나눠 쓴다
// ─────────────────────────────────────────────────────────────

/**
 * 세션 한 건.
 *
 * ## 왜 녹음과 갈랐나
 *
 * 예전에는 녹음 하나가 곧 세션이었다 — 에이전트를 부를 때마다 `recordingId`
 * 로 세션을 잡았고, 다듬기는 아예 일회용(`ephemeral`)이었다. 그래서 방금
 * 다듬으며 정한 화자 이름과 용어를 대화창이 몰랐고, 지난주 회의에서 배운
 * 것을 이번 주 회의가 물려받을 길이 없었다.
 *
 * 세션을 일급으로 두면 그 둘이 한 번에 풀린다. 값은 되풀이되는 자리에서
 * 나온다 — 같은 사람, 같은 용어, 같은 화자 이름.
 *
 * ## `agent_key` 를 왜 id 와 따로 두나
 *
 * 이 값이 BentoAgent 쪽 claude 세션의 열쇠다. id 와 같아도 될 것 같지만
 * **갈아 끼울 수 있어야 한다.** 맥락이 상한에 닿으면 사람은 이 세션의
 * 이름과 녹음 목록은 그대로 두고 에이전트 맥락만 새로 시작하고 싶어 한다
 * (`rollover`). 그때 바꾸는 것이 이 칸이다. id 를 바꾸면 붙어 있는 녹음이
 * 전부 떨어진다.
 *
 * 모양은 `[A-Za-z0-9_-]{1,64}` 여야 한다 — 저쪽 `isChatKey` 가 그것만 받는다.
 * 앞에 `s-` 를 붙이는 이유는 `session-server.ts` 에 적어 두었다.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /** 사람이 붙이는 이름. "주간 회의" 처럼. */
    name: text("name").notNull(),

    /** BentoAgent 의 claude 세션 열쇠. 위 설명을 보라. */
    agentKey: text("agent_key").notNull(),

    /**
     * 지금까지 이 세션의 에이전트 맥락에 부은 글자 수.
     *
     * 다듬기에 넘긴 전사문과 대화에 매 턴 싣는 전사문을 더해 센다. 그
     * 맥락은 `--resume` 으로 이어 붙으므로 **줄어들지 않는다.** 상한을 넘으면
     * 거절한다 (`lib/session-server.ts`). 조용히 자르지 않는다.
     *
     * `rollover` 로 열쇠를 갈면 0 으로 돌아간다 — 새 claude 세션이니까.
     */
    contextChars: integer("context_chars").notNull().default(0),

    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => ({
    /** 목록은 최근에 손댄 순이다. 올릴 때 고르는 칸이 그 순서로 뜬다. */
    byUpdated: index("sessions_updated_idx").on(t.updatedAt),
    /**
     * 열쇠는 겹치면 안 된다.
     *
     * 두 세션이 같은 열쇠를 들면 **저쪽에서는 한 세션이다** — 서로 다른
     * 회의의 맥락이 조용히 한 자루에 섞이고, 화면에는 그 사실이 어디에도
     * 안 나온다. 열쇠는 uid() 로 만들어 겹칠 일이 사실상 없지만, 사실상
     * 없는 것과 있을 수 없는 것은 다르다.
     */
    uniqueAgentKey: uniqueIndex("sessions_agent_key_uq").on(t.agentKey),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;

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

    /**
     * 어느 세션에서 처리되나. 없으면 null.
     *
     * **null 이 정상적인 상태다.** 두 가지 경우가 있다.
     *
     * 1. 세션이 생기기 전에 올린 녹음. 마이그레이션이 일부러 null 로 둔다
     *    (`drizzle/0001_sessions.sql` 의 설명).
     * 2. 붙어 있던 세션이 지워진 녹음. 아래 `set null` 이 그 자리다.
     *
     * null 일 때는 예전 그대로 **녹음 하나가 곧 세션**이다 — 에이전트 열쇠가
     * 녹음 id 가 된다 (`lib/session-server.ts` 의 `agentKeyFor`). 그러니
     * 이 칸이 비어 있다고 못 쓰는 녹음이 아니다.
     *
     * `onDelete: "set null"` 인 이유: 세션을 지우는 것은 **맥락을 버리는
     * 뜻**이지 전사문을 버리는 뜻이 아니다. cascade 로 두면 이름 하나를
     * 지우려다 몇 시간짜리 전사문이 통째로 사라진다.
     */
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),

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

    /**
     * 사람이 적어 준 화자 목록. `["김", "이", …]` JSON. **비어 있어도 된다.**
     *
     * 화자 분리에 줄 무리 수가 여기서 나온다 — `k = 목록 인원 + 2`
     * (`diar-models.ts` 의 `clusterCountFor`). 수를 아예 안 주면 진짜 회의에서
     * 화자가 **40~134명** 나오므로 반드시 무언가를 준다 (빈 목록이면 k=3).
     *
     * **넉넉히 적는 쪽이 낫다.** 한 명 빠뜨리면 −8.3pt, 한 명 더 적으면
     * +4.1pt 다 — 비대칭이 분명해서 화면 문구도 그렇게 물어야 한다
     * (`ROSTER_HINT`).
     *
     * 이 칸은 **지금 값**이다. 어느 판을 돌릴 때 무엇을 썼는지는
     * `diarizations.roster` 에 따로 찍힌다 — 사람이 나중에 목록을 고쳐도
     * 이미 붙은 결과가 어떤 목록에서 나왔는지는 남아 있어야 한다.
     */
    roster: text("roster").notNull().default("[]"),

    /**
     * 화자 분리가 어디까지 갔나. **`state` 를 건드리지 않는다.**
     *
     * 분리가 실패해도 전사문은 온전하다. 그 사실을 지키는 자리가 이 칸이다 —
     * 실패를 `state` 에 적으면 멀쩡한 전사문이 빨간 글씨를 달고 앉는다.
     */
    speakerState: text("speaker_state", { enum: SPEAKER_STATES }).notNull().default("none"),
    /** 왜 못 붙였나. 사람이 읽는 문장. 종료 코드를 그대로 적지 않는다. */
    speakerError: text("speaker_error"),

    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (t) => ({
    /** 목록은 늘 최신순이다. */
    byCreated: index("recordings_created_idx").on(t.createdAt),
    /** 다시 떴을 때 도는 중이던 것을 찾는 길. */
    byState: index("recordings_state_idx").on(t.state),
    /**
     * 세션 하나에 붙은 녹음을 세고 모으는 길.
     *
     * 목록을 그릴 때마다 세션마다 개수를 세고, 다듬기를 줄 세울 때마다 같은
     * 세션에서 도는 것이 있는지 본다. 둘 다 이 색인을 지난다.
     */
    bySession: index("recordings_session_idx").on(t.sessionId),
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

    /**
     * 이 줄의 화자 **이름.**
     *
     * ## 소리로 가른 줄에는 이 칸이 안 쓰인다
     *
     * 음향 화자 분리가 내놓는 것은 이름이 아니라 **군집 번호**이고(아래
     * `speakerCluster`), 번호에 이름을 다는 표는 녹음 하나에 하나뿐이다
     * (`diarizations.names`). 이름을 조각마다 베껴 두면 이름 하나를 고칠 때
     * 수천 줄을 다시 써야 하고, 그중 한 줄이라도 빠지면 화면에 두 이름이 섞인다.
     * 그래서 읽을 때 번호 → 이름으로 푼다.
     *
     * 값이 남아 있는 줄은 둘이다. **에이전트가 대사에서 추정한 옛 줄**
     * (마이그레이션이 `speakerSource = "agent-guess"` 로 찍는다)과 **사람이
     * 손으로 적은 줄**(`"human"`). 둘 다 손대지 않는다.
     */
    speaker: text("speaker"),

    /**
     * 소리로 가른 군집 번호. 이 조각에서 **가장 오래 말한** 군집이다.
     *
     * 이름이 아니라 번호인 이유는 위에 적었다. 한 조각 안에서 화자가 바뀌는
     * 일이 흔하므로(AMI 조각의 52.2%에 정답 화자가 둘 이상) 이 값은 "대표"
     * 일 뿐이고, 실제로 읽을 때 쓰는 것은 아래 `speakerRuns` 다.
     */
    speakerCluster: integer("speaker_cluster"),

    /** 누가 정했나. 위 `SPEAKER_SOURCES` 를 보라. 아무도 안 정했으면 null. */
    speakerSource: text("speaker_source", { enum: SPEAKER_SOURCES }),

    /**
     * **낱말별 화자 런.** `[{k, s, e, sil}]` JSON — 조각을 빈틈없이 덮는다.
     *
     * ## 왜 낱말이 아니라 토막인가
     *
     * 낱말마다 한 칸을 두면 AMI 9편에서 32,091줄이 되는데, 같은 군집이
     * 잇따르는 자리를 묶으면 1,131개다 — 28배 작고 잃는 것이 없다.
     *
     * ## 왜 낱말 번호가 아니라 **시각**인가
     *
     * 낱말 시각을 안 주는 모델(`timestamps: "none"`)이 있다. 그때는 글자 수에
     * 비례해 조각을 나누는데(68.4%, 조각 통째 61.9%보다 낫다), 그 토막은
     * 낱말과 1:1 이 아니다. 시각으로 적어 두면 두 길이 같은 모양으로 저장되고,
     * 화면은 제가 가진 것(낱말 시각이든 글자 수든)으로 시각을 찾아 나누면 된다.
     *
     * ## 왜 여기 담나 — **줄을 새로 만들지 않는다**
     *
     * `segments` 의 유일 색인 `(recording_id, idx)` 의 그 `idx` 가 에이전트에게
     * 보내는 번호다. 화자가 바뀔 때마다 행을 쪼개면 번호가 흔들리고, 그러면
     * `raw` 의 불변성도 `edited` 보호도 다듬기 계약도 함께 흔들린다.
     *
     * `sil` 은 그 토막의 실루엣이다. **"틀렸다" 가 아니라 "덜 확실하다" 로만**
     * **써라** — 딴 파일에서 고른 문턱으로 정밀도 79.0% · 재현율 6.9% 다.
     */
    speakerRuns: text("speaker_runs").notNull().default("[]"),

    /**
     * 이 조각 으뜸 군집의 실루엣. 모르면 null.
     *
     * 위 런 안에도 값이 있지만 이 칸을 따로 둔다 — 줄 하나가 얼마나 미덥나를
     * 묻는 자리(목록·요약·정렬)가 JSON 을 풀지 않고 답할 수 있어야 한다.
     * 대부분의 조각은 런이 하나라 사실상 같은 값이다.
     */
    speakerSil: real("speaker_sil"),

    /**
     * 다듬기가 붙인 표시. 없으면 null.
     *
     * ## 왜 이 칸이 생겼나
     *
     * 이 전사 모델은 못 알아듣는 소리에 **빈 글이 아니라 그럴듯한 영어를
     * 지어낸다** (실측: 한국어 오디오에 "Here's snucker, your foo's nick…").
     * 그 사실을 모르는 에이전트는 그 헛소리를 매끄러운 문장으로 "다듬어"
     * 버리고, 다듬고 나면 사람이 한 말인지 기계가 지어낸 것인지 가를 길이
     * 사라진다.
     *
     * 모델의 제약을 알려 주면 다듬는 대신 **표시**하게 할 수 있다. 그 표시가
     * 앉는 자리다. `raw` 는 그대로 남아 있으므로, 이 칸은 "왜 raw 그대로
     * 두었는가" 에 대한 답이기도 하다.
     *
     * 열거값만 받는다 (`SEGMENT_FLAGS`). 자유 문장으로 열면 남이 만든
     * 소리에서 나온 글이 화면에 앉는 자리가 하나 더 생기는데, 얻는 것이
     * 없다 — 무슨 말이었는지는 이미 `text` 에 있다.
     */
    flag: text("flag", { enum: SEGMENT_FLAGS }),

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
//   화자 분리 — 녹음 하나에 한 판
// ─────────────────────────────────────────────────────────────

/**
 * 화자 분리 한 판의 결과. 녹음 하나에 하나다 (`summaries` 와 같은 결).
 *
 * ## 왜 `recordings` 에 칸을 더하지 않고 표를 갈랐나
 *
 * `turns` 가 크다. 99분짜리에서 구간 1,019개 · 34KB 였고 180분이면 그 두
 * 배다. 그런데 목록 화면(`listRecordings`)은 `recordings` 의 **모든 칸**을
 * 읽고 그 질의가 화면을 열 때마다 돈다. 같은 행에 두면 녹음 50건짜리 목록
 * 한 번에 몇 MB 를 긁게 된다 — 아무도 안 보는 자료를.
 *
 * 대신 `speakerState`·`speakerError` 만 `recordings` 에 남겼다. 그 둘은
 * 목록에 실제로 뜨는 값이고 작다.
 *
 * ## 왜 날 구간을 저장하나
 *
 * **문턱만 바꿔 다시 붙일 때 워커를 다시 안 돌리려는 것이다.** 붙이는 셈
 * (`lib/diarize-assign.ts`)은 sherpa 를 안 부르는 순수 함수라 밀리초면
 * 끝나는데, 그 앞의 분리는 21분짜리에 332~356초가 걸렸다. λ 를 바꾸거나
 * 군집→이름 표가 달라졌다고 그 몇 분을 다시 치를 이유가 없다.
 */
export const diarizations = sqliteTable("diarizations", {
  recordingId: text("recording_id")
    .primaryKey()
    .references(() => recordings.id, { onDelete: "cascade" }),

  /** 어느 모델로 돌렸나. `scripts/diar-models.json` 의 id. */
  modelId: text("model_id").notNull(),

  /**
   * **이 판을 돌릴 때** 사람이 적어 준 목록. `recordings.roster` 의 그때 값이다.
   *
   * 지금 값과 따로 두는 이유: 사람이 나중에 이름을 더하거나 고쳐도 이미
   * 붙은 결과는 옛 목록에서 나온 것이다. 그 둘이 어긋나 보일 때 "왜 이런
   * 결과가 나왔나" 에 답할 수 있는 유일한 자리다.
   */
  roster: text("roster").notNull().default("[]"),

  /**
   * 워커에게 준 무리 수 `k`. **목록 인원 + 2 다** (`clusterCountFor`).
   *
   * `k = L` 을 쓰면 안 된다: AMI 에서 −7.0pt·DER +8.6pt 이고, 사용자의 진짜
   * 녹음 한 편(21분 26초, 3명)에서 k=3 이 셋째 사람의 낱말 197개를 **197개 전부**
   * 둘째 사람에게 붙였다.
   */
  clusters: integer("clusters").notNull(),
  /** 실제로 나온 군집 수. `clusters` 보다 적을 수 있다. */
  found: integer("found").notNull().default(0),

  /**
   * 날 구간. `[{s, e, k, sil}]` JSON. **워커가 낸 그대로**(+ 실루엣을 합쳤다).
   *
   * 실루엣은 워커가 0.2초 미만 구간을 건너뛰므로 `null` 일 수 있다.
   */
  turns: text("turns").notNull().default("[]"),

  /**
   * 구간 실루엣의 중앙값. **이 녹음을 통째로 의심할 것인가**의 근거다.
   *
   * 문턱은 서술자가 준다 (`fileWarnSilhouetteMedian`, 지금 0.25). 파일 단위
   * 정확도와 Spearman 0.72~0.97 로 붙어 다닌다. 원래 쓰려던 "나온 수 <
   * 요청한 수" 는 AMI 9편에서 **0번** 울렸다 — 쓰지 마라.
   */
  silhouetteMedian: real("silhouette_median"),

  /**
   * 실루엣을 **왜 못 쟀나.** 쟀으면 null. 사람이 읽는 문장.
   *
   * `silhouetteMedian` 이 null 이면 파일 경고도 줄마다의 "덜 확실하다" 도 하나도
   * 안 뜬다. 그 모습은 "잘 갈렸다" 와 똑같이 보인다 — 실제로는 **재지 못한**
   * 것인데. 그래서 이유를 따로 적어 두고 화면과 에이전트가 그 사실을 말한다.
   * 이유가 셋이라(길이 때문에 접었다 · 재다 죽었다 · 워커가 값을 안 냈다)
   * 중앙값 칸 하나로는 가를 수 없다.
   */
  silhouetteNote: text("silhouette_note"),

  /**
   * 군집마다 맡은 시간. `[{k, seconds}]` JSON, **많은 순.**
   *
   * 에이전트에게 주는 힌트가 이 순서다 — 1등 군집이 목록의 1등 화자인 것이
   * AMI 9편 중 8편이었다. **첫 등장 순서는 주지 마라**: 27.8~36.1% 로 찍기와
   * 다르지 않은데 그럴듯해 보여서 에이전트가 근거로 삼는다.
   *
   * 이름을 나눠 줄 때도 이 순서를 쓴다 — **상위 L개에만 이름, 나머지는
   * `other`.** 실루엣으로 고르면 목록에 적은 사람 말의 30%를 버리고 정확도가
   * 18.6pt 깎인다.
   */
  talkTime: text("talk_time").notNull().default("[]"),

  /**
   * 군집 → 이름. `{"0": "김", "2": "other"}` JSON. 아직 없으면 `{}`.
   *
   * **에이전트가 채운다.** 음향이 말한 시간 순서만으로 이름을 맞히면
   * 64.9%(신탁 70.6%)이고 개별 파일에서 20%까지 무너진다. 그래서 에이전트가
   * 대사를 읽고 정하고, 여기 **표 하나로** 받는다 — 줄마다의 화자를 돌려받는
   * 자리는 없앴다.
   */
  names: text("names").notNull().default("{}"),

  /** 분리에 걸린 시간(ms). 다음 판을 어림할 재료. */
  msProcess: integer("ms_process"),

  createdAt: stamp("created_at"),
  updatedAt: stamp("updated_at"),
});

export type DiarizationRow = typeof diarizations.$inferSelect;

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
