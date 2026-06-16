CREATE TABLE `scim_sync_event` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`user_id` varchar(64),
	`action` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`payload_json` json,
	`next_retry_at` timestamp(3),
	`resolved_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `scim_sync_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `scim_sync_event_org_status` ON `scim_sync_event` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `scim_sync_event_provider_status` ON `scim_sync_event` (`provider_id`,`status`);--> statement-breakpoint
CREATE INDEX `scim_sync_event_next_retry` ON `scim_sync_event` (`next_retry_at`);--> statement-breakpoint
CREATE INDEX `scim_sync_event_user` ON `scim_sync_event` (`user_id`);
