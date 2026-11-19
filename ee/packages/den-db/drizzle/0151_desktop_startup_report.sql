CREATE TABLE `desktop_startup_report` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`attempt_id` varchar(36) NOT NULL,
	`app_version` varchar(64) NOT NULL,
	`platform` varchar(16) NOT NULL,
	`success` boolean NOT NULL,
	`failed_step` varchar(16),
	`failure_reason` varchar(32),
	`window_ms` int,
	`engine_ms` int,
	`signed_in_ms` int,
	`org_tools_ms` int,
	`observed_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `desktop_startup_report_id` PRIMARY KEY(`id`),
	CONSTRAINT `desktop_startup_report_org_attempt` UNIQUE(`organization_id`,`attempt_id`)
);
--> statement-breakpoint
CREATE INDEX `desktop_startup_report_org_observed` ON `desktop_startup_report` (`organization_id`,`observed_at`);