CREATE TABLE `automation_team_share` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`automation_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`access` enum('view','manage') NOT NULL,
	`shared_by_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_team_share_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_team_share_automation_team` UNIQUE(`automation_id`,`team_id`)
);
--> statement-breakpoint
CREATE INDEX `automation_team_share_team` ON `automation_team_share` (`organization_id`,`team_id`);