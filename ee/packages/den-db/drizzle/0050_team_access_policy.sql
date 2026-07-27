ALTER TABLE `plugin_access_grant` ADD COLUMN `source` enum('manual','policy') NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE `config_object_access_grant` ADD COLUMN `source` enum('manual','policy') NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE `marketplace_access_grant` ADD COLUMN `source` enum('manual','policy') NOT NULL DEFAULT 'manual';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_access_policy` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`plugin_id` varchar(64) NOT NULL,
	`role` enum('viewer','editor','manager') NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`removed_at` timestamp(3),
	CONSTRAINT `team_access_policy_id` PRIMARY KEY(`id`),
	CONSTRAINT `team_access_policy_team_plugin` UNIQUE(`team_id`,`plugin_id`)
);
--> statement-breakpoint
CREATE INDEX `team_access_policy_organization_id` ON `team_access_policy` (`organization_id`);--> statement-breakpoint
CREATE INDEX `team_access_policy_team_id` ON `team_access_policy` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_access_policy_plugin_id` ON `team_access_policy` (`plugin_id`);
