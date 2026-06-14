ALTER TABLE `telemetry_event` ADD `source` varchar(32);--> statement-breakpoint
ALTER TABLE `telemetry_event` ADD `session_id` varchar(128);--> statement-breakpoint
ALTER TABLE `telemetry_event` ADD `duration_ms` int;--> statement-breakpoint
ALTER TABLE `telemetry_event` ADD `success` boolean;