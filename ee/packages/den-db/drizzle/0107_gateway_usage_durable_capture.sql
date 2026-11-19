ALTER TABLE `gateway_usage_consumption_event` ADD `request_started_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `gateway_usage_consumption_event` ADD `admission_snapshot` json;--> statement-breakpoint
ALTER TABLE `gateway_usage_consumption_event` ADD `pending_counted` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_consumption_event` ADD `tracking_version` int;--> statement-breakpoint
ALTER TABLE `gateway_usage_tracking` ADD `epoch_version` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_tracking` ADD `capture_enabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `gateway_usage_pending_member` ON `gateway_usage_consumption_event` (`member_id`,`pending_counted`,`admitted_at`,`id`);