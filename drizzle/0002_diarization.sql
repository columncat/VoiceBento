-- 음향 화자 분리를 붙인다. **이미 배포된 DB 에 얹히는 마이그레이션이다.**
--
-- drizzle-kit 이 뽑은 것에 맨 아래 UPDATE 한 줄을 손으로 더했다. 왜 더했는지는
-- 그 자리에 적어 두었다.
--
-- ## 옛 녹음은 건드리지 않는다
--
-- 지금까지 화면에 뜨던 화자 이름은 **에이전트가 대사에서 추정한 것**이다.
-- 소리를 안 들었다. 새 길(소리로 가르기)이 생겼다고 그 줄들을 지우거나 다시
-- 돌리지 않는다 — 사람이 이미 읽은 전사문이고, 그중 일부는 손으로 고쳐 둔
-- 것이다. 바꾸는 것은 **근거를 적는 것뿐**이다 (`speaker_source`).
--
-- 다시 붙이고 싶으면 사람이 단추를 누른다. 그때 `speaker_source` 가
-- `agent-guess` 인 줄은 덮이고 `human` 인 줄은 그대로 남는다. 사람이 손댄
-- 줄(`edited = 1`)은 맨 아래 UPDATE 가 `human` 으로 찍는다 — 그 까닭도 거기 있다.
--
-- ## 새 칸이 옛 줄에 무엇을 뜻하나
--
--   recordings.roster        '[]'   — 아직 아무도 안 적었다. k 를 셀 때 최소 1명으로 깐다.
--   recordings.speaker_state 'none' — 분리를 한 적이 없다. 실패가 아니다.
--   segments.speaker_runs    '[]'   — 소리로 가른 토막이 없다. 화면은 조각 통째로 그린다.
--   segments.speaker_cluster NULL   — 군집 번호가 없다.
--
-- ## `diarizations` 를 왜 따로 파나
--
-- 날 구간(`turns`)이 크다 — 99분짜리에서 1,019개 · 34KB. 그런데 목록 화면은
-- `recordings` 의 모든 칸을 읽고 그 질의가 화면을 열 때마다 돈다. 같은 행에
-- 두면 목록 한 번에 몇 MB 를 긁는다. 자세한 근거는 `lib/db/schema.ts` 에 있다.

CREATE TABLE `diarizations` (
	`recording_id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`roster` text DEFAULT '[]' NOT NULL,
	`clusters` integer NOT NULL,
	`found` integer DEFAULT 0 NOT NULL,
	`turns` text DEFAULT '[]' NOT NULL,
	`silhouette_median` real,
	`silhouette_note` text,
	`talk_time` text DEFAULT '[]' NOT NULL,
	`names` text DEFAULT '{}' NOT NULL,
	`ms_process` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `recordings` ADD `roster` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `speaker_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `speaker_error` text;--> statement-breakpoint
ALTER TABLE `segments` ADD `speaker_cluster` integer;--> statement-breakpoint
ALTER TABLE `segments` ADD `speaker_source` text;--> statement-breakpoint
ALTER TABLE `segments` ADD `speaker_runs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `segments` ADD `speaker_sil` real;--> statement-breakpoint
-- **손으로 더한 줄.** 지금까지 붙어 있던 화자 이름에 근거를 적는다.
--
-- 이 값들은 전부 에이전트가 대사의 흐름에서 추정한 것이다. 소리로 가른 것과
-- 같은 얼굴로 화면에 앉으면 사람은 둘 다 같은 무게로 믿는데, 둘은 근거가
-- 다르다 — 한쪽은 목소리를 쟀고 한쪽은 문맥을 읽었다.
--
-- **사람이 손댄 줄(`edited = 1`)은 `human` 으로 찍는다.**
--
-- 0001 판에는 근거 칸이 없어서 사람이 화자를 고친 흔적은 `edited = 1` 하나로만
-- 남아 있다. 그 줄까지 `agent-guess` 로 찍으면, 화자를 소리로 나누는 순간
-- `putSpeakerAssignments` 가 그 줄을 `acoustic` 으로 덮고 화면은 풀어낸 이름
-- ("화자 2")을 앞세운다. DB 에는 사람이 적은 '지훈' 이 남아 있어도 **어느 화면에도
-- 안 뜬다** — 실제로 재현했다.
--
-- `edited = 1` 은 글만 고친 줄에도 선다 (0001 은 둘을 가르지 않았다). 그 줄의
-- 화자까지 사람의 것으로 치면 소리로 나눠도 그 줄만 옛 이름으로 남는다. 그래도
-- 이쪽으로 틀리는 것이 맞다: 옛 이름이 남는 것은 보이고 줄에서 고칠 수 있지만,
-- 사람이 적은 이름이 가려지는 것은 아무 데도 안 보인다.
UPDATE `segments` SET `speaker_source` = CASE WHEN `edited` = 1 THEN 'human' ELSE 'agent-guess' END WHERE `speaker` IS NOT NULL;
