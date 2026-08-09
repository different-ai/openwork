ALTER TABLE `connector_sync_event` ADD `attempt_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_sync_event` ADD `next_attempt_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `connector_sync_event_status_next_attempt_at` ON `connector_sync_event` (`status`,`next_attempt_at`);