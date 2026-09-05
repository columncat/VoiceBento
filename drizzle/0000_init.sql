CREATE TABLE `agent_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	`actor` text DEFAULT 'agent' NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `app_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`auto_polish` integer DEFAULT 1 NOT NULL,
	`settings` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	`type` text NOT NULL,
	`success` integer DEFAULT 0 NOT NULL,
	`user_agent` text
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`file_id` text,
	`source_name` text DEFAULT '' NOT NULL,
	`source_size` integer DEFAULT 0 NOT NULL,
	`duration` real,
	`state` text DEFAULT 'queued' NOT NULL,
	`progress` real,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`notice` text,
	`polish_job_id` text,
	`polish_error` text,
	`polish_started_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_created_idx` ON `recordings` (`created_at`);--> statement-breakpoint
CREATE INDEX `recordings_state_idx` ON `recordings` (`state`);--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`idx` integer NOT NULL,
	`start` real NOT NULL,
	`end` real NOT NULL,
	`raw` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`speaker` text,
	`words` text DEFAULT '[]' NOT NULL,
	`edited` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `segments_recording_idx_uq` ON `segments` (`recording_id`,`idx`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`recording_id` text PRIMARY KEY NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'human' NOT NULL,
	`instruction` text,
	`state` text,
	`job_id` text,
	`error` text,
	`started_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
