CREATE TABLE `client_failure_report` (
	`report_id` varchar(36) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`schema_version` int NOT NULL,
	`occurred_at` timestamp(3) NOT NULL,
	`component` varchar(20) NOT NULL,
	`phase` varchar(10) NOT NULL,
	`reason` varchar(24) NOT NULL,
	`app_version` varchar(64) NOT NULL,
	`platform` varchar(8) NOT NULL,
	`arch` varchar(8) NOT NULL,
	`exit_code` int,
	`http_status` int,
	`count` int NOT NULL,
	`received_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `client_failure_report_report_id` PRIMARY KEY(`report_id`)
);
--> statement-breakpoint
CREATE INDEX `client_failure_occurred` ON `client_failure_report` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `client_failure_org_occurred` ON `client_failure_report` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `client_failure_class_occurred` ON `client_failure_report` (`component`,`reason`,`occurred_at`);