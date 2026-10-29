CREATE TABLE `organization_benefit_setting` (
	`organization_id` varchar(64) NOT NULL,
	`feature` enum('freeAuto','openworkWeb') NOT NULL,
	`setting` enum('enabled','disabled') NOT NULL,
	`updated_by_user_id` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `organization_benefit_setting_organization_id_feature_pk` PRIMARY KEY(`organization_id`,`feature`)
);
--> statement-breakpoint
CREATE TABLE `organization_grant` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`feature` enum('freeAuto','openworkWeb') NOT NULL,
	`kind` enum('access','usage','unlimited') NOT NULL,
	`amount` bigint,
	`used_amount` bigint NOT NULL DEFAULT 0,
	`starts_at` timestamp(3) NOT NULL,
	`expires_at` timestamp(3),
	`reason` varchar(500) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`revoked_at` timestamp(3),
	`revoked_by_user_id` varchar(64),
	CONSTRAINT `organization_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_grant_request` UNIQUE(`organization_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `organization_grant_usage` (
	`grant_id` varchar(64) NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`amount` bigint NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `organization_grant_usage_grant_id_request_id_pk` PRIMARY KEY(`grant_id`,`request_id`)
);
--> statement-breakpoint
CREATE INDEX `organization_grant_active` ON `organization_grant` (`organization_id`,`feature`,`revoked_at`,`starts_at`);