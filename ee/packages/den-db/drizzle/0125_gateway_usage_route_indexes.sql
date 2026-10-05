CREATE INDEX `gateway_request_logs_org_route_started` ON `gateway_request_logs` (`organization_id`,`route`,`started_at`);--> statement-breakpoint
CREATE INDEX `gateway_usage_rollups_org_route_granularity_bucket` ON `gateway_usage_rollups` (`organization_id`,`route`,`granularity`,`bucket_start`);--> statement-breakpoint
DROP INDEX `gateway_request_logs_org_started` ON `gateway_request_logs`;--> statement-breakpoint
DROP INDEX `gateway_usage_rollups_org_granularity_bucket` ON `gateway_usage_rollups`;
