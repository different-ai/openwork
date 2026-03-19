CREATE TABLE `desktop_handoff_grant` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`session_token` text NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`consumed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	CONSTRAINT `desktop_handoff_grant_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `desktop_handoff_grant_user_id` ON `desktop_handoff_grant` (`user_id`);
--> statement-breakpoint
CREATE INDEX `desktop_handoff_grant_expires_at` ON `desktop_handoff_grant` (`expires_at`);
