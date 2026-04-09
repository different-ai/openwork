ALTER TABLE `worker`
	ADD `last_heartbeat_at` timestamp(3);
--> statement-breakpoint
ALTER TABLE `worker`
	ADD `last_active_at` timestamp(3);
--> statement-breakpoint
CREATE INDEX `worker_last_heartbeat_at` ON `worker` (`last_heartbeat_at`);
--> statement-breakpoint
CREATE INDEX `worker_last_active_at` ON `worker` (`last_active_at`);
--> statement-breakpoint
ALTER TABLE `worker_token`
	MODIFY COLUMN `scope` enum('client','host','activity') NOT NULL;
