ALTER TABLE `gateway_usage_bucket` ADD `unpriced_requests` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket_charge` ADD `unpriced_requests` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `gateway_usage_assignment_member_lookup` ON `gateway_usage_limit_assignment` (`organization_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `gateway_usage_assignment_team_lookup` ON `gateway_usage_limit_assignment` (`organization_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `gateway_usage_reset_bucket_history` ON `gateway_usage_reset_request` (`bucket_id`,`created_at`,`id`);