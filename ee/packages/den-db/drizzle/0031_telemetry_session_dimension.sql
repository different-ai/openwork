CREATE TABLE `telemetry_session_dimension` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`session_id` varchar(128) NOT NULL,
	`source` varchar(32) NOT NULL,
	`dimension_type` varchar(64) NOT NULL,
	`dimension_value` varchar(128) NOT NULL,
	`dimension_label` varchar(255) NOT NULL,
	`metadata` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`last_seen_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `telemetry_session_dimension_id` PRIMARY KEY(`id`),
	CONSTRAINT `telemetry_session_dimension_org_source_session_type` UNIQUE(`org_id`,`source`,`session_id`,`dimension_type`)
);
--> statement-breakpoint
CREATE INDEX `telemetry_session_dimension_filter` ON `telemetry_session_dimension` (`org_id`,`dimension_type`,`dimension_value`,`session_id`);--> statement-breakpoint
CREATE INDEX `telemetry_event_org_session_ts` ON `telemetry_event` (`org_id`,`session_id`,`event_timestamp`);
