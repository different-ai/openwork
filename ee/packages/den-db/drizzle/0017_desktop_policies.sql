CREATE TABLE `desktop_policy` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`policy_name` varchar(255) NOT NULL,
	`is_default` boolean,
	`is_enabled` boolean NOT NULL DEFAULT true,
	`policy` json NOT NULL DEFAULT (json_object()),
	`created_by_org_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`deleted_at` timestamp(3),
	CONSTRAINT `desktop_policy_id` PRIMARY KEY(`id`),
	CONSTRAINT `desktop_policy_org_default` UNIQUE(`organization_id`,`is_default`)
);
--> statement-breakpoint
CREATE TABLE `desktop_policy_member` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`desktop_policy_id` varchar(64) NOT NULL,
	`org_member_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `desktop_policy_member_id` PRIMARY KEY(`id`),
	CONSTRAINT `desktop_policy_member_policy_org_member` UNIQUE(`desktop_policy_id`,`org_member_id`),
	CONSTRAINT `desktop_policy_member_policy_team` UNIQUE(`desktop_policy_id`,`team_id`)
);
--> statement-breakpoint
CREATE INDEX `desktop_policy_organization_id` ON `desktop_policy` (`organization_id`);--> statement-breakpoint
CREATE INDEX `desktop_policy_created_by_member_id` ON `desktop_policy` (`created_by_org_member_id`);--> statement-breakpoint
CREATE INDEX `desktop_policy_is_enabled` ON `desktop_policy` (`is_enabled`);--> statement-breakpoint
CREATE INDEX `desktop_policy_deleted_at` ON `desktop_policy` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `desktop_policy_member_organization_id` ON `desktop_policy_member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `desktop_policy_member_policy_id` ON `desktop_policy_member` (`desktop_policy_id`);--> statement-breakpoint
CREATE INDEX `desktop_policy_member_org_member_id` ON `desktop_policy_member` (`org_member_id`);--> statement-breakpoint
CREATE INDEX `desktop_policy_member_team_id` ON `desktop_policy_member` (`team_id`);
