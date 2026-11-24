CREATE TABLE `harness_feedback_organization` (
	`organization_id` varchar(64) NOT NULL,
	`enabled_by` varchar(64) NOT NULL,
	`enabled_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `harness_feedback_organization_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `harness_feedback_slack` (
	`id` varchar(16) NOT NULL,
	`webhook_url` mediumtext NOT NULL,
	`updated_by` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `harness_feedback_slack_id` PRIMARY KEY(`id`)
);
