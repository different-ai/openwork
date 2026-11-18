CREATE TABLE `gateway_usage_limit_assignment` (
	`id` varchar(64) NOT NULL,
	`policy_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `gateway_usage_limit_assignment_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_usage_assignment_member` UNIQUE(`policy_id`,`member_id`),
	CONSTRAINT `gateway_usage_assignment_team` UNIQUE(`policy_id`,`team_id`),
	CONSTRAINT `gateway_usage_assignment_target` CHECK((`gateway_usage_limit_assignment`.`member_id` is null) <> (`gateway_usage_limit_assignment`.`team_id` is null))
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_audit` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`actor_id` varchar(64),
	`subject_id` varchar(64) NOT NULL,
	`action` varchar(64) NOT NULL,
	`details` json NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `gateway_usage_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_bucket` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`timeframe` enum('day','week','month') NOT NULL,
	`start_at` timestamp(3) NOT NULL,
	`reset_at` timestamp(3) NOT NULL,
	`policy_id` varchar(64) NOT NULL,
	`policy_name` varchar(120) NOT NULL,
	`policy_revision` int NOT NULL,
	`base_allowance_micro_usd` bigint NOT NULL DEFAULT 0,
	`extension_micro_usd` bigint NOT NULL DEFAULT 0,
	`used_micro_usd` bigint NOT NULL DEFAULT 0,
	`extension_used` boolean NOT NULL DEFAULT false,
	`hard_limit` boolean NOT NULL,
	`allow_request_reset` boolean NOT NULL,
	CONSTRAINT `gateway_usage_bucket_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_usage_bucket_window` UNIQUE(`organization_id`,`member_id`,`timeframe`,`start_at`),
	CONSTRAINT `gateway_usage_bucket_money_safe` CHECK(`gateway_usage_bucket`.`used_micro_usd` between 0 and 9007199254740991 and `gateway_usage_bucket`.`base_allowance_micro_usd` + `gateway_usage_bucket`.`extension_micro_usd` between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_bucket_charge` (
	`event_id` varchar(64) NOT NULL,
	`bucket_id` varchar(64) NOT NULL,
	`amount` bigint NOT NULL DEFAULT 0,
	`policy_id` varchar(64) NOT NULL,
	`policy_revision` int NOT NULL,
	CONSTRAINT `gateway_usage_bucket_charge_event_id_bucket_id_pk` PRIMARY KEY(`event_id`,`bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_consumption_event` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`admitted_at` timestamp(3) NOT NULL,
	`cost_micro_usd` bigint,
	`unpriced_requests` int NOT NULL DEFAULT 1,
	`complete` boolean NOT NULL DEFAULT false,
	`finalized` boolean NOT NULL DEFAULT false,
	`source` varchar(32) NOT NULL,
	`settled_at` timestamp(3),
	CONSTRAINT `gateway_usage_consumption_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_usage_event_money_safe` CHECK(`gateway_usage_consumption_event`.`cost_micro_usd` is null or `gateway_usage_consumption_event`.`cost_micro_usd` between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_limit_entry` (
	`policy_id` varchar(64) NOT NULL,
	`timeframe` enum('day','week','month') NOT NULL,
	`cost_limit_micro_usd` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `gateway_usage_limit_entry_policy_id_timeframe_pk` PRIMARY KEY(`policy_id`,`timeframe`),
	CONSTRAINT `gateway_usage_allowance_safe` CHECK(`gateway_usage_limit_entry`.`cost_limit_micro_usd` >= 0 and `gateway_usage_limit_entry`.`cost_limit_micro_usd` <= 7205759403792792)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_limit_policy` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`hard_limit` boolean NOT NULL DEFAULT true,
	`allow_request_reset` boolean NOT NULL DEFAULT true,
	`revision` int NOT NULL DEFAULT 1,
	`archived_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	CONSTRAINT `gateway_usage_limit_policy_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_reset_request` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`bucket_id` varchar(64) NOT NULL,
	`policy_id` varchar(64) NOT NULL,
	`policy_revision` int NOT NULL,
	`timeframe` enum('day','week','month') NOT NULL,
	`policy_name` varchar(120) NOT NULL,
	`reason` text NOT NULL,
	`status` enum('pending','approved','denied','expired') NOT NULL,
	`pending_bucket_id` varchar(64),
	`base_allowance_micro_usd` bigint NOT NULL DEFAULT 0,
	`allowance_micro_usd` bigint NOT NULL DEFAULT 0,
	`used_micro_usd` bigint NOT NULL DEFAULT 0,
	`reset_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	`reviewed_at` timestamp(3),
	`reviewed_by` varchar(64),
	`denial_note` text,
	CONSTRAINT `gateway_usage_reset_request_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_usage_reset_pending` UNIQUE(`pending_bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_usage_subject` (
	`member_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`tracking_since` timestamp(3) NOT NULL,
	`initialized_at` timestamp(3) NOT NULL,
	CONSTRAINT `gateway_usage_subject_member_id` PRIMARY KEY(`member_id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_usage_assignment_org` ON `gateway_usage_limit_assignment` (`organization_id`);--> statement-breakpoint
CREATE INDEX `gateway_usage_audit_org` ON `gateway_usage_audit` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `gateway_usage_bucket_member` ON `gateway_usage_bucket` (`member_id`,`reset_at`);--> statement-breakpoint
CREATE INDEX `gateway_usage_charge_bucket` ON `gateway_usage_bucket_charge` (`bucket_id`);--> statement-breakpoint
CREATE INDEX `gateway_usage_event_member_time` ON `gateway_usage_consumption_event` (`member_id`,`admitted_at`);--> statement-breakpoint
CREATE INDEX `gateway_usage_policy_org` ON `gateway_usage_limit_policy` (`organization_id`);--> statement-breakpoint
CREATE INDEX `gateway_usage_reset_org` ON `gateway_usage_reset_request` (`organization_id`,`created_at`);