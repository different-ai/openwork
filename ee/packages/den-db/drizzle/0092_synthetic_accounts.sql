CREATE TABLE `synthetic_account` (
	`email` varchar(255) NOT NULL,
	`run_id` varchar(128) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `synthetic_account_email` PRIMARY KEY(`email`)
);
--> statement-breakpoint
ALTER TABLE `user` ADD `synthetic_run_id` varchar(128);--> statement-breakpoint
ALTER TABLE `organization` ADD `synthetic_run_id` varchar(128);