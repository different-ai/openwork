CREATE TABLE `platform_audit_event` (
	`id` varchar(64) NOT NULL,
	`occurred_at` timestamp(3) NOT NULL,
	`request_id` varchar(128),
	`method` varchar(16) NOT NULL,
	`route` varchar(512) NOT NULL,
	`action` varchar(128) NOT NULL,
	`outcome` enum('succeeded','failed','denied','unknown') NOT NULL,
	`status` smallint unsigned NOT NULL,
	`reason_code` varchar(128),
	`actor_type` enum('user','service','unknown') NOT NULL,
	`actor_id` varchar(255),
	`credential_id` varchar(255),
	`origin` enum('api','cloud_ui','mcp','scheduler','webhook','platform_admin') NOT NULL,
	`target_type` varchar(64),
	`target_id` varchar(255),
	CONSTRAINT `platform_audit_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `platform_audit_event_time` ON `platform_audit_event` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_audit_event_actor_time` ON `platform_audit_event` (`actor_id`,`occurred_at`);