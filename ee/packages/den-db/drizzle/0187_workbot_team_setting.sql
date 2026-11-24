CREATE TABLE `workbot_team_setting` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`settings` json NOT NULL,
	`updated_by_org_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `workbot_team_setting_id` PRIMARY KEY(`id`),
	CONSTRAINT `workbot_team_setting_team` UNIQUE(`organization_id`,`team_id`)
);
--> statement-breakpoint
CREATE INDEX `workbot_team_setting_team_id` ON `workbot_team_setting` (`team_id`);