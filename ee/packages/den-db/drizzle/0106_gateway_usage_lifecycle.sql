CREATE TABLE `gateway_usage_tracking` (
	`member_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`tracking_started_at` timestamp(3) NOT NULL,
	`pending_requests` bigint NOT NULL DEFAULT 0,
	`last_settlement_at` timestamp(3),
	`last_settlement_request_id` varchar(64),
	CONSTRAINT `gateway_usage_tracking_member_id` PRIMARY KEY(`member_id`),
	CONSTRAINT `gateway_usage_tracking_pending_safe` CHECK(`gateway_usage_tracking`.`pending_requests` between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket` ADD `incomplete_requests` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket` ADD `history_unknown` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket_charge` ADD `incomplete_requests` bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `gateway_usage_tracking_org` ON `gateway_usage_tracking` (`organization_id`);