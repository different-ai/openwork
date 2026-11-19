CREATE TABLE `headless_resume_grant` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`session_id` varchar(128) NOT NULL,
	`message_id` varchar(128) NOT NULL,
	`read_only` boolean NOT NULL DEFAULT false,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`revoked_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`last_used_at` timestamp(3),
	`use_count` int NOT NULL DEFAULT 0,
	CONSTRAINT `headless_resume_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `headless_resume_grant_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `headless_resume_grant_member` ON `headless_resume_grant` (`user_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `headless_resume_grant_expires_at` ON `headless_resume_grant` (`expires_at`);