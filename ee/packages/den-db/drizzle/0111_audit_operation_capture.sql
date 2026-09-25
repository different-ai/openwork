CREATE TABLE `audit_event_resource` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`operation_id` varchar(64) NOT NULL,
	`resource_type` varchar(64) NOT NULL,
	`resource_id` varchar(255) NOT NULL,
	`relationship` enum('target','parent','related') NOT NULL,
	`label` varchar(255),
	CONSTRAINT `audit_event_resource_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_operation` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`binding_key` char(64) NOT NULL,
	`kind` varchar(128) NOT NULL,
	`scope` varchar(512) NOT NULL,
	`principal_key` varchar(512) NOT NULL,
	`initiating_actor` json NOT NULL,
	`origin` enum('api','cloud_ui','mcp','scheduler','webhook','platform_admin') NOT NULL,
	`origin_trust` enum('authenticated','reported') NOT NULL,
	`first_recorded_at` timestamp(3) NOT NULL,
	`attachment_expires_at` timestamp(3) NOT NULL,
	`outcome` enum('running','succeeded','failed','partial','unknown') NOT NULL DEFAULT 'unknown',
	`retention_state` enum('retained','evicting') NOT NULL DEFAULT 'retained',
	`event_count` bigint unsigned NOT NULL DEFAULT 0,
	`logical_bytes` bigint unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `audit_operation_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_operation_binding` UNIQUE(`organization_id`,`binding_key`)
);
--> statement-breakpoint
CREATE TABLE `audit_policy` (
	`organization_id` varchar(64) NOT NULL,
	`revision` int unsigned NOT NULL,
	`source` enum('cloud','operator') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`categories` json NOT NULL,
	`allowance` bigint unsigned NOT NULL,
	`excess_mode` enum('delete_oldest','paid_overage','keep_all') NOT NULL,
	`effective_at` timestamp(3) NOT NULL,
	`capture_started_at` timestamp(3),
	`attachment_window_seconds` int unsigned NOT NULL,
	CONSTRAINT `audit_policy_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_state` (
	`organization_id` varchar(64) NOT NULL,
	`last_sequence` bigint unsigned NOT NULL DEFAULT 0,
	`retained_operations` bigint unsigned NOT NULL DEFAULT 0,
	`event_count` bigint unsigned NOT NULL DEFAULT 0,
	`logical_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_state_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_usage_fact` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`operation_id` varchar(64) NOT NULL,
	`delta` int NOT NULL,
	`effective_at` timestamp(3) NOT NULL,
	`policy_revision` int unsigned NOT NULL,
	`allowance` bigint unsigned NOT NULL,
	`excess_mode` enum('delete_oldest','paid_overage','keep_all') NOT NULL,
	CONSTRAINT `audit_usage_fact_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_usage_operation_transition` UNIQUE(`organization_id`,`operation_id`,`delta`)
);
--> statement-breakpoint
ALTER TABLE `audit_event` MODIFY COLUMN `actor_user_id` varchar(64);--> statement-breakpoint
ALTER TABLE `audit_event` ADD `operation_id` varchar(64);--> statement-breakpoint
ALTER TABLE `audit_event` ADD `sequence` bigint unsigned;--> statement-breakpoint
ALTER TABLE `audit_event` ADD `envelope` json;--> statement-breakpoint
ALTER TABLE `audit_event` ADD `logical_bytes` bigint unsigned;--> statement-breakpoint
ALTER TABLE `audit_event` ADD `idempotency_key` char(64);--> statement-breakpoint
ALTER TABLE `audit_event` ADD `content_hash` char(64);--> statement-breakpoint
ALTER TABLE `audit_event` ADD CONSTRAINT `audit_event_org_sequence` UNIQUE(`org_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `audit_event` ADD CONSTRAINT `audit_event_idempotency` UNIQUE(`org_id`,`operation_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `audit_resource_lookup` ON `audit_event_resource` (`organization_id`,`resource_type`,`resource_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `audit_resource_event` ON `audit_event_resource` (`organization_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `audit_resource_operation` ON `audit_event_resource` (`organization_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `audit_operation_org_time` ON `audit_operation` (`organization_id`,`first_recorded_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_operation_retention` ON `audit_operation` (`organization_id`,`retention_state`,`first_recorded_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_usage_org_time` ON `audit_usage_fact` (`organization_id`,`effective_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_event_operation_sequence` ON `audit_event` (`org_id`,`operation_id`,`sequence`);