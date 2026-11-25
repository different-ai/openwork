CREATE TABLE `support_triage_settings` (
	`id` varchar(16) NOT NULL,
	`plain_api_key` mediumtext,
	`slack_webhook_url` mediumtext,
	`enabled_at` timestamp(3),
	`polled_through` timestamp(3),
	`revision` varchar(36) NOT NULL,
	`updated_by` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `support_triage_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `support_triage_thread` (
	`id` varchar(64) NOT NULL,
	`plain_thread_id` varchar(128) NOT NULL,
	`workspace_id` varchar(128) NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	`title` mediumtext NOT NULL,
	`preview` mediumtext,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`category` varchar(24),
	`judgment_detail` mediumtext,
	`label_applied` boolean NOT NULL DEFAULT false,
	`disposition_applied` boolean NOT NULL DEFAULT false,
	`slack_state` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` timestamp(3) NOT NULL DEFAULT (now()),
	`lease_owner` varchar(36),
	`lease_expires_at` timestamp(3),
	CONSTRAINT `support_triage_thread_id` PRIMARY KEY(`id`),
	CONSTRAINT `support_triage_plain_thread` UNIQUE(`plain_thread_id`)
);
--> statement-breakpoint
CREATE INDEX `support_triage_due` ON `support_triage_thread` (`workspace_id`,`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `support_triage_created` ON `support_triage_thread` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `support_triage_category_created` ON `support_triage_thread` (`category`,`created_at`,`id`);