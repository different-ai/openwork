CREATE TABLE `memory_context` (
	`id` varchar(64) NOT NULL,
	`memory_id` varchar(64) NOT NULL,
	`citation` json,
	`snippet` text NOT NULL,
	`origin` enum('active_conversation','searched_conversation'),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `memory_context_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `memory` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`scope` enum('user','org') NOT NULL DEFAULT 'user',
	`content` text NOT NULL,
	`source` varchar(64) NOT NULL,
	`tags` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `memory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `memory_context_memory_id` ON `memory_context` (`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_user_id` ON `memory` (`user_id`);--> statement-breakpoint
-- FULLTEXT indexes cannot be expressed via Drizzle's mysql-core DSL (drizzle-orm#1495), so
-- it is appended here for the migrate path. The fresh-install (push + baseline) path skips
-- this migration, so `ensureMemoryFulltextIndex` (bootstrap.ts) creates it idempotently there.
CREATE FULLTEXT INDEX `memory_content_fulltext` ON `memory` (`content`);