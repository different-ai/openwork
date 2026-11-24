CREATE TABLE `capability_usage_rollup_lock` (
	`id` int NOT NULL,
	CONSTRAINT `capability_usage_rollup_lock_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capability_usage_rollups` (
	`id` varchar(64) NOT NULL,
	`bucket_start` timestamp(3) NOT NULL,
	`dimension_key` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`plugin_id` varchar(64),
	`config_object_id` varchar(64),
	`connection_id` varchar(64),
	`use_count` int NOT NULL DEFAULT 0,
	`ok_count` int NOT NULL DEFAULT 0,
	`error_count` int NOT NULL DEFAULT 0,
	`source_row_count` int NOT NULL DEFAULT 0,
	`source_counts` json NOT NULL,
	`last_used_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `capability_usage_rollups_id` PRIMARY KEY(`id`),
	CONSTRAINT `capability_usage_rollups_bucket_dimension` UNIQUE(`bucket_start`,`dimension_key`)
);
--> statement-breakpoint
ALTER TABLE `capability_usage_event` DROP INDEX `capability_usage_dedupe`;--> statement-breakpoint
ALTER TABLE `capability_usage_event` ADD `source` varchar(32) DEFAULT 'agent' NOT NULL;--> statement-breakpoint
CREATE INDEX `capability_usage_rollups_org_bucket` ON `capability_usage_rollups` (`organization_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `capability_usage_rollups_member` ON `capability_usage_rollups` (`organization_id`,`org_membership_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `capability_usage_rollups_object` ON `capability_usage_rollups` (`organization_id`,`kind`,`config_object_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `capability_usage_rollups_connection` ON `capability_usage_rollups` (`organization_id`,`kind`,`connection_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `capability_usage_rollups_plugin` ON `capability_usage_rollups` (`organization_id`,`plugin_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `capability_usage_created` ON `capability_usage_event` (`created_at`);--> statement-breakpoint
CREATE INDEX `capability_usage_member` ON `capability_usage_event` (`organization_id`,`org_membership_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `capability_usage_event` DROP COLUMN `tool_name`;--> statement-breakpoint
ALTER TABLE `capability_usage_event` DROP COLUMN `via`;--> statement-breakpoint
ALTER TABLE `capability_usage_event` DROP COLUMN `dedupe_key`;