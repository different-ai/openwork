CREATE TABLE `capability_usage_event` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`plugin_id` varchar(64),
	`config_object_id` varchar(64),
	`via` varchar(32) NOT NULL,
	`dedupe_key` varchar(191) NOT NULL,
	`outcome` varchar(32),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `capability_usage_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `capability_usage_dedupe` UNIQUE(`organization_id`,`dedupe_key`)
);
--> statement-breakpoint
CREATE INDEX `capability_usage_object` ON `capability_usage_event` (`organization_id`,`kind`,`config_object_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `capability_usage_recent` ON `capability_usage_event` (`organization_id`,`created_at`);