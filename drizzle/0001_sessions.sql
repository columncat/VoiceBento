-- 세션을 일급으로.
--
-- **이미 배포된 DB 에 얹히는 마이그레이션이다.** 이 파일은 drizzle-kit 이 뽑은
-- 것을 눈으로 확인하고 한 줄 고친 것이다. 고친 자리는 아래 `ON DELETE SET NULL`
-- 하나이고, 왜 고쳤는지도 거기 적어 두었다.
--
-- ## 기존 녹음은 어떻게 하나 — 세션 없이 둔다 (session_id 는 NULL)
--
-- 고른 것 셋 중에 이것이다. 근거:
--
-- 1. **기본 세션에 몰기** 는 안 된다. 서로 아무 상관도 없는 지난 녹음들이
--    한 맥락이 되고, 그 다음 다듬기부터 남의 회의에서 온 화자 이름과 용어를
--    물려받는다. 세션의 값이 "되풀이되는 자리에서 물려받기" 인데, 그것을
--    아무 근거 없이 켜 버리는 셈이다. 게다가 이미 사람의 서버에 있는 자료에
--    조용히 일어난다.
-- 2. **하나씩 새 세션 만들기** 는 지금 동작과 같지만(녹음 하나 = 세션 하나)
--    이름 없는 세션 행이 녹음 수만큼 생긴다. 사람이 세션 목록을 열면 처음
--    보는 이름 수십 개를 치워야 하고, 그 치우는 일에 아무 값이 없다.
-- 3. **NULL 로 두기** 는 정직하다 — "이 녹음은 세션이 생기기 전 것이다".
--    그리고 NULL 갈래는 **어차피 코드에 있어야 한다**: 세션을 지우면 붙어
--    있던 녹음이 이 상태가 되고, 세션을 안 고르고 올릴 수도 있다. 기존
--    녹음을 여기에 두면 그 갈래가 죽은 코드가 아니라 늘 밟히는 길이 된다.
--
-- NULL 인 녹음은 예전과 **똑같이** 돈다: 에이전트 열쇠가 녹음 id 이므로
-- 지금까지 쌓인 대화 기록도 그대로 이어진다 (lib/session-server.ts 의
-- agentKeyFor). 되던 것이 하나도 안 깨진다는 뜻이다.
--
-- ## segments.flag
--
-- 기존 줄은 NULL 이다. "표시 없음" 과 같은 뜻이므로 채워 넣을 것이 없다.
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`agent_key` text NOT NULL,
	`context_chars` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_updated_idx` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_agent_key_uq` ON `sessions` (`agent_key`);--> statement-breakpoint
-- **손으로 고친 줄.** drizzle-kit 은 `REFERENCES sessions(id)` 까지만 뽑았고
-- 삭제 규칙을 빠뜨렸다. 그대로 두면 SQLite 의 기본값인 NO ACTION 이 되어,
-- 녹음이 하나라도 붙어 있는 세션을 지우려는 순간 외래키 위반으로 실패한다
-- (`foreign_keys = ON` 이라 진짜로 막힌다). 사람은 이름 하나를 지우려던
-- 것뿐인데 "FOREIGN KEY constraint failed" 를 보게 된다.
--
-- SET NULL 인 이유: 세션을 지우는 것은 **맥락을 버리는 뜻**이지 전사문을
-- 버리는 뜻이 아니다. CASCADE 였다면 이름 하나를 지우다 몇 시간짜리
-- 전사문이 통째로 사라진다 — 되돌릴 수 없는 쪽이다.
--
-- SQLite 는 ADD COLUMN 에 REFERENCES 를 허용한다. 조건이 하나 있는데
-- (기본값이 NULL 이어야 한다) 여기는 기본값 자체가 없으니 만족한다.
ALTER TABLE `recordings` ADD `session_id` text REFERENCES `sessions`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `recordings_session_idx` ON `recordings` (`session_id`);--> statement-breakpoint
ALTER TABLE `segments` ADD `flag` text;
