CREATE TABLE `aws_deployment_event` (
	`id` varchar(36) NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`sequence` int NOT NULL,
	`step` varchar(40) NOT NULL,
	`outcome` enum('succeeded','failed') NOT NULL,
	`error_code` varchar(64),
	`received_at` timestamp(3) NOT NULL,
	CONSTRAINT `aws_deployment_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `aws_deployment_event_run_sequence` UNIQUE(`run_id`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `aws_deployment_run` (
	`id` varchar(36) NOT NULL,
	`deployment_id` varchar(36) NOT NULL,
	`version` varchar(80) NOT NULL,
	`challenge` varchar(64) NOT NULL,
	`state` enum('awaiting_aws','provisioning','ready','failed') NOT NULL,
	`token_hash` varchar(64),
	`last_sequence` int NOT NULL DEFAULT 0,
	`last_seen_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `aws_deployment_run_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `aws_deployment` (
	`id` varchar(36) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`name` varchar(80) NOT NULL,
	`account_id` varchar(12) NOT NULL,
	`region` varchar(32) NOT NULL,
	`domain_name` varchar(253) NOT NULL,
	`route53_zone_id` varchar(32) NOT NULL,
	`owner_email` varchar(254) NOT NULL,
	`active_run_id` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `aws_deployment_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `aws_deployment_run_deployment` ON `aws_deployment_run` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `aws_deployment_org` ON `aws_deployment` (`org_id`);