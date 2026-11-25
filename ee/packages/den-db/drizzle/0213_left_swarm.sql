CREATE TABLE `harness_feedback_group` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`fingerprint` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`category` varchar(64),
	`surface` varchar(24) NOT NULL,
	`tool` varchar(80),
	`report_count` int NOT NULL DEFAULT 0,
	`first_seen_at` timestamp(3) NOT NULL DEFAULT (now()),
	`last_seen_at` timestamp(3) NOT NULL DEFAULT (now()),
	`notify_state` varchar(16) NOT NULL DEFAULT 'pending',
	`notify_attempts` int NOT NULL DEFAULT 0,
	`notify_lease_owner` varchar(64),
	`notify_lease_expires_at` timestamp(3),
	`notified_at` timestamp(3),
	CONSTRAINT `harness_feedback_group_id` PRIMARY KEY(`id`),
	CONSTRAINT `harness_feedback_group_org_fingerprint` UNIQUE(`organization_id`,`fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `harness_feedback_report` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`client_kind` varchar(16) NOT NULL,
	`surface` varchar(24) NOT NULL,
	`tool` varchar(80),
	`error_code` varchar(64),
	`symptom` mediumtext NOT NULL,
	`workaround` mediumtext,
	`state` varchar(16) NOT NULL DEFAULT 'pending',
	`group_id` varchar(64),
	`category` varchar(64),
	`judgment_detail` mediumtext,
	`attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` timestamp(3) NOT NULL DEFAULT (now()),
	`lease_owner` varchar(64),
	`lease_expires_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `harness_feedback_report_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `harness_feedback_group_org_seen` ON `harness_feedback_group` (`organization_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `harness_feedback_group_notify_due` ON `harness_feedback_group` (`notify_state`,`notify_lease_expires_at`);--> statement-breakpoint
CREATE INDEX `harness_feedback_report_due` ON `harness_feedback_report` (`state`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `harness_feedback_report_org_created` ON `harness_feedback_report` (`organization_id`,`group_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `harness_feedback_report_member_created` ON `harness_feedback_report` (`organization_id`,`member_id`,`created_at`);