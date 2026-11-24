-- Restore Organization Analytics tables. Installs that never applied the
-- original 0128 still have both tables (with these exact columns and indexes)
-- and their data; IF NOT EXISTS leaves them untouched. Installs that did apply
-- it get empty tables. Indexes are inline because MySQL has no
-- CREATE INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS `telemetry_event` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`event_timestamp` timestamp(3) NOT NULL,
	`source` varchar(32),
	`session_id` varchar(128),
	`duration_ms` int,
	`success` boolean,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `telemetry_event_id` PRIMARY KEY(`id`),
	INDEX `telemetry_event_org_id_type_ts` (`org_id`,`event_type`,`event_timestamp`),
	INDEX `telemetry_event_org_id_member_id` (`org_id`,`member_id`),
	INDEX `telemetry_event_member_ts` (`member_id`,`event_timestamp`),
	INDEX `telemetry_event_org_session_ts` (`org_id`,`session_id`,`event_timestamp`),
	INDEX `telemetry_event_org_ts_window` (`org_id`,`event_timestamp`,`event_type`,`member_id`,`session_id`,`source`,`duration_ms`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `telemetry_session_dimension` (
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
	CONSTRAINT `telemetry_session_dimension_org_source_session_type` UNIQUE(`org_id`,`source`,`session_id`,`dimension_type`),
	INDEX `telemetry_session_dimension_filter` (`org_id`,`dimension_type`,`dimension_value`,`session_id`)
);
