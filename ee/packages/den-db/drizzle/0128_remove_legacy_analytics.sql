-- Retire app adoption analytics. Gateway usage, accounting, consent settings,
-- and operational Workflow results are intentionally preserved.
DROP TABLE `telemetry_event`;--> statement-breakpoint
DROP TABLE `telemetry_session_dimension`;--> statement-breakpoint
-- The shared event table still serves Gateway inference. Delete only retired
-- desktop metadata; never delete source='inference' records.
DELETE FROM `models_analytics_event` WHERE `source` = 'app';