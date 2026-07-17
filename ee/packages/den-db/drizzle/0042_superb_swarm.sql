CREATE TABLE `scim_group_member` (
	`id` varchar(64) NOT NULL,
	`group_id` varchar(64) NOT NULL,
	`remote_user_id` varchar(191) NOT NULL,
	`user_id` varchar(64),
	`org_membership_id` varchar(64),
	`team_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `scim_group_member_id` PRIMARY KEY(`id`),
	CONSTRAINT `scim_group_member_group_remote_user` UNIQUE(`group_id`,`remote_user_id`)
);
--> statement-breakpoint
CREATE TABLE `scim_group` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`external_id` varchar(191),
	`display_name` varchar(255) NOT NULL,
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `scim_group_id` PRIMARY KEY(`id`),
	CONSTRAINT `scim_group_provider_external_id` UNIQUE(`provider_id`,`external_id`),
	CONSTRAINT `scim_group_team_id` UNIQUE(`team_id`)
);
--> statement-breakpoint
CREATE TABLE `scim_user_tombstone` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`deprovisioned_user_id` varchar(64),
	`external_id` varchar(191),
	`email` varchar(191),
	`deprovisioned_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `scim_user_tombstone_id` PRIMARY KEY(`id`),
	CONSTRAINT `scim_user_tombstone_org_user` UNIQUE(`organization_id`,`deprovisioned_user_id`)
);
--> statement-breakpoint
ALTER TABLE `scim_provider` ADD `group_mapping_mode` varchar(32) DEFAULT 'metadata_only' NOT NULL;--> statement-breakpoint
CREATE INDEX `scim_group_member_user_id` ON `scim_group_member` (`user_id`);--> statement-breakpoint
CREATE INDEX `scim_group_member_org_membership_id` ON `scim_group_member` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `scim_group_member_team_member_id` ON `scim_group_member` (`team_member_id`);--> statement-breakpoint
CREATE INDEX `scim_group_organization_id` ON `scim_group` (`organization_id`);--> statement-breakpoint
CREATE INDEX `scim_group_provider_id` ON `scim_group` (`provider_id`);--> statement-breakpoint
CREATE INDEX `scim_user_tombstone_org_external_id` ON `scim_user_tombstone` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `scim_user_tombstone_org_email` ON `scim_user_tombstone` (`organization_id`,`email`);