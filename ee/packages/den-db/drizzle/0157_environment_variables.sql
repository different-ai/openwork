CREATE TABLE `environment_variable_access` (
	`id` varchar(64) NOT NULL,
	`environment_variable_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`value` text,
	`updated_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `environment_variable_access_id` PRIMARY KEY(`id`),
	CONSTRAINT `environment_variable_access_variable_member` UNIQUE(`environment_variable_id`,`org_membership_id`),
	CONSTRAINT `environment_variable_access_variable_team` UNIQUE(`environment_variable_id`,`team_id`)
);
--> statement-breakpoint
CREATE TABLE `environment_variable_member_setting` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`environment_variable_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`value` text,
	`selected_access_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `environment_variable_member_setting_id` PRIMARY KEY(`id`),
	CONSTRAINT `environment_variable_member_setting_variable_member` UNIQUE(`environment_variable_id`,`org_membership_id`)
);
--> statement-breakpoint
CREATE TABLE `environment_variable` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`env_key` varchar(255) NOT NULL,
	`description` text,
	`value_mode` enum('admin','per_member') NOT NULL DEFAULT 'admin',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `environment_variable_id` PRIMARY KEY(`id`),
	CONSTRAINT `environment_variable_org_key` UNIQUE(`organization_id`,`env_key`)
);
--> statement-breakpoint
CREATE INDEX `environment_variable_access_org_membership_id` ON `environment_variable_access` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `environment_variable_access_team_id` ON `environment_variable_access` (`team_id`);--> statement-breakpoint
CREATE INDEX `environment_variable_member_setting_organization_id` ON `environment_variable_member_setting` (`organization_id`);--> statement-breakpoint
CREATE INDEX `environment_variable_member_setting_org_membership_id` ON `environment_variable_member_setting` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `environment_variable_created_by` ON `environment_variable` (`created_by_org_membership_id`);