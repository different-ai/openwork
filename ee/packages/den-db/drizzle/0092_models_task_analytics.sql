CREATE TABLE `models_analytics_event` (
	`id` varchar(64) NOT NULL,
	`event_id` varchar(128) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`source` varchar(16) NOT NULL,
	`type` varchar(32) NOT NULL,
	`timestamp` timestamp(3) NOT NULL,
	`session_id` varchar(128) NOT NULL,
	`task_id` varchar(128) NOT NULL,
	`model` varchar(255),
	`provider` varchar(255),
	`input_tokens` double,
	`output_tokens` double,
	`cache_read_tokens` double,
	`cost_usd` double,
	`usage_complete` boolean,
	`payload` json NOT NULL,
	`exported_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `models_analytics_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `models_analytics_dedup` UNIQUE(`org_id`,`member_id`,`source`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `models_analytics_settings` (
	`org_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`consented_at` timestamp(3),
	`consented_by` varchar(64),
	`consent_version` int,
	`export_enabled` boolean NOT NULL DEFAULT false,
	`export_enabled_at` timestamp(3),
	`langfuse_host` varchar(512),
	`langfuse_public_key` text,
	`langfuse_secret_key` text,
	CONSTRAINT `models_analytics_settings_org_id` PRIMARY KEY(`org_id`)
);
--> statement-breakpoint
CREATE INDEX `models_analytics_activity` ON `models_analytics_event` (`org_id`,`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `models_analytics_task` ON `models_analytics_event` (`org_id`,`member_id`,`session_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `models_analytics_consumption` ON `models_analytics_event` (`org_id`,`type`,`timestamp`);--> statement-breakpoint
CREATE INDEX `models_analytics_export` ON `models_analytics_event` (`org_id`,`exported_at`,`created_at`);