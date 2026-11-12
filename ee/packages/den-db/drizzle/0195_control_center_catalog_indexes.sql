CREATE INDEX `marketplace_status_created_at` ON `marketplace` (`status`,`created_at`,`name`);--> statement-breakpoint
CREATE INDEX `plugin_status_created_at` ON `plugin` (`status`,`created_at`);