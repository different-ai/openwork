CREATE TABLE IF NOT EXISTS `admin_metric_refresh_lease` (
	`metric_key` varchar(64) NOT NULL,
	`owner` varchar(64),
	`lease_until` timestamp(3),
	`requested_at` timestamp(3),
	CONSTRAINT `admin_metric_refresh_lease_metric_key` PRIMARY KEY(`metric_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `admin_metric_snapshot` (
	`metric_key` varchar(64) NOT NULL,
	`range_key` varchar(16) NOT NULL,
	`payload` json,
	`computed_at` timestamp(3),
	`duration_ms` int,
	`error` varchar(500),
	`attempted_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `admin_metric_snapshot_metric_range` PRIMARY KEY(`metric_key`,`range_key`)
);
--> statement-breakpoint
CREATE INDEX `invitation_created_at` ON `invitation` (`created_at`);--> statement-breakpoint
CREATE INDEX `telemetry_event_ts_window` ON `telemetry_event` (`event_timestamp`,`event_type`,`source`,`member_id`,`session_id`);