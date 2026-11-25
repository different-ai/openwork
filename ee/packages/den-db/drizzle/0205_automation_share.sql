CREATE TABLE `automation_share` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`automation_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`org_wide` boolean NOT NULL DEFAULT false,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `automation_share_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_share_member` UNIQUE(`automation_id`,`org_membership_id`),
	CONSTRAINT `automation_share_team` UNIQUE(`automation_id`,`team_id`)
);
--> statement-breakpoint
CREATE INDEX `automation_share_automation` ON `automation_share` (`automation_id`);--> statement-breakpoint
CREATE INDEX `automation_share_org_member` ON `automation_share` (`organization_id`,`org_membership_id`);--> statement-breakpoint
CREATE INDEX `automation_share_org_team` ON `automation_share` (`organization_id`,`team_id`);