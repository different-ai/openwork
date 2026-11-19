CREATE TABLE `free_auto_limit_events` (
	`id` varchar(64) NOT NULL,
	`audience` enum('guest','member') NOT NULL,
	`subject_hash` varchar(64) NOT NULL,
	`user_id` varchar(64),
	`organization_id` varchar(64),
	`window_start_at` timestamp(3) NOT NULL,
	`exhausted_at` timestamp(3) NOT NULL,
	`authenticated_at` timestamp(3),
	CONSTRAINT `free_auto_limit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `free_auto_purchases` (
	`subscription_id` varchar(255) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`type` enum('inference','seat','web') NOT NULL,
	`started_at` timestamp(3) NOT NULL,
	`paid_at` timestamp(3) NOT NULL,
	CONSTRAINT `free_auto_purchases_subscription_id` PRIMARY KEY(`subscription_id`)
);
--> statement-breakpoint
-- Preserve unrelated legacy dashboard tables.
CREATE INDEX `free_auto_limit_time` ON `free_auto_limit_events` (`exhausted_at`,`id`);--> statement-breakpoint
CREATE INDEX `free_auto_limit_subject` ON `free_auto_limit_events` (`audience`,`subject_hash`,`exhausted_at`);--> statement-breakpoint
CREATE INDEX `free_auto_limit_user` ON `free_auto_limit_events` (`user_id`,`exhausted_at`);--> statement-breakpoint
CREATE INDEX `free_auto_limit_org` ON `free_auto_limit_events` (`organization_id`);--> statement-breakpoint
CREATE INDEX `free_auto_purchase_user_start` ON `free_auto_purchases` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `free_auto_purchase_org` ON `free_auto_purchases` (`organization_id`);