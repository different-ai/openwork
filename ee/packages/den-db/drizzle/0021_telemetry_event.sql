-- Backfill: telemetry_event shipped (#1658) without a migration file and only
-- exists in databases that ran `db:push`. Idempotent so it is safe either way.
CREATE TABLE IF NOT EXISTS `telemetry_event` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`event_timestamp` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `telemetry_event_id` PRIMARY KEY(`id`),
	INDEX `telemetry_event_org_id_type_ts` (`org_id`,`event_type`,`event_timestamp`),
	INDEX `telemetry_event_org_id_member_id` (`org_id`,`member_id`)
);
