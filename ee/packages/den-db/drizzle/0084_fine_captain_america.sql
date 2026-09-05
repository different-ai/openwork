ALTER TABLE `worker` ADD `cloud_failure_code` varchar(64);--> statement-breakpoint
ALTER TABLE `worker` ADD `cloud_failure_stage` varchar(32);--> statement-breakpoint
ALTER TABLE `worker` ADD `cloud_failure_reference` varchar(64);--> statement-breakpoint
ALTER TABLE `worker` ADD `cloud_failure_at` timestamp(3);