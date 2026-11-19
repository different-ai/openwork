ALTER TABLE `capability_usage_event` ADD `connection_id` varchar(64);--> statement-breakpoint
ALTER TABLE `capability_usage_event` ADD `tool_name` varchar(255);--> statement-breakpoint
CREATE INDEX `capability_usage_connection` ON `capability_usage_event` (`organization_id`,`kind`,`connection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `capability_usage_plugin` ON `capability_usage_event` (`organization_id`,`plugin_id`,`created_at`);