CREATE TABLE `process_timing_run` (
	`run_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`process` varchar(8) NOT NULL,
	`environment` varchar(5) NOT NULL,
	`commit` varchar(40),
	`started_at` varchar(24) NOT NULL,
	`total_seconds` double NOT NULL,
	`outcome` varchar(4) NOT NULL,
	`steps` json NOT NULL,
	`received_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `process_timing_run_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
CREATE INDEX `process_timing_run_started` ON `process_timing_run` (`started_at`);--> statement-breakpoint
CREATE INDEX `process_timing_run_received` ON `process_timing_run` (`received_at`);--> statement-breakpoint
CREATE INDEX `process_timing_run_filter_started` ON `process_timing_run` (`process`,`environment`,`started_at`);