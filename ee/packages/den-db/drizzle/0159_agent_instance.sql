-- One idempotent statement per table, indexes inline: PlanetScale applies DDL
-- outside the transaction (see 0145).
CREATE TABLE IF NOT EXISTS `agent_delivery` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`responsibility` varchar(32) NOT NULL,
	`outcome` varchar(16) NOT NULL DEFAULT 'pending',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_delivery_id` PRIMARY KEY(`id`),
	INDEX `agent_delivery_member` (`member_id`,`created_at`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_instance` (
	`member_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`template_version_id` varchar(64),
	`status` varchar(8),
	`overrides` json,
	`snoozed_until` timestamp(3),
	`state` mediumtext,
	`time_zone` varchar(64),
	`next_wake_at` timestamp(3) NOT NULL DEFAULT (now()),
	`failures` int NOT NULL DEFAULT 0,
	`lease_owner` varchar(64),
	`lease_until` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_instance_member_id` PRIMARY KEY(`member_id`),
	INDEX `agent_instance_due` (`next_wake_at`),
	INDEX `agent_instance_org` (`organization_id`)
);
