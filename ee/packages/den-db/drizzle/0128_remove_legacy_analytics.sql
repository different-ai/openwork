-- Intentionally does nothing. This migration used to drop `telemetry_event` and
-- `telemetry_session_dimension` and delete `models_analytics_event` rows with
-- source = 'app'. Organization Analytics is coming back, so installs that have
-- not applied it yet keep that data. Drizzle only compares migration timestamps,
-- so databases that already applied the old version are not affected.
SELECT 1;
