CREATE TABLE `gateway_usage_quarantine` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`admitted_at` timestamp(3) NOT NULL,
	`received_at` timestamp(3) NOT NULL,
	`cost_micro_usd` bigint,
	`reason` varchar(64) NOT NULL,
	CONSTRAINT `gateway_usage_quarantine_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_usage_quarantine_member_time` ON `gateway_usage_quarantine` (`member_id`,`admitted_at`);