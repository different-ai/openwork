CREATE TABLE `managed_deployment_event` (
	`id` varchar(36) NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`sequence` int NOT NULL,
	`step` varchar(40) NOT NULL,
	`outcome` enum('succeeded','failed') NOT NULL,
	`error_code` varchar(64),
	`received_at` timestamp(3) NOT NULL,
	CONSTRAINT `managed_deployment_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `managed_deployment_event_run_sequence` UNIQUE(`run_id`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `managed_deployment_health` (
	`deployment_id` varchar(36) NOT NULL,
	`version` varchar(80),
	`checks` json NOT NULL,
	`reported_at` timestamp(3) NOT NULL,
	`signed_at` timestamp(3) NOT NULL,
	CONSTRAINT `managed_deployment_health_deployment_id` PRIMARY KEY(`deployment_id`)
);
--> statement-breakpoint
CREATE TABLE `managed_deployment_run` (
	`id` varchar(36) NOT NULL,
	`deployment_id` varchar(36) NOT NULL,
	`kind` enum('install','update','retry') NOT NULL,
	`version` varchar(80) NOT NULL,
	`template_url` varchar(2048) NOT NULL,
	`bundle_url` varchar(2048) NOT NULL,
	`bundle_sha256` varchar(64) NOT NULL,
	`api_origin` varchar(512) NOT NULL,
	`challenge` varchar(64) NOT NULL,
	`state` enum('awaiting_approval','provisioning','ready','failed') NOT NULL,
	`token_hash` varchar(64),
	`last_sequence` int NOT NULL DEFAULT 0,
	`last_seen_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `managed_deployment_run_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `managed_deployment` (
	`id` varchar(36) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`provider` enum('aws','azure','gcp') NOT NULL,
	`name` varchar(80) NOT NULL,
	`target` json NOT NULL,
	`domain_name` varchar(253) NOT NULL,
	`owner_email` varchar(254) NOT NULL,
	`size` varchar(20) NOT NULL,
	`active_run_id` varchar(36),
	`installed_version` varchar(80),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `managed_deployment_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `managed_deployment_run_deployment` ON `managed_deployment_run` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `managed_deployment_org` ON `managed_deployment` (`org_id`);