ALTER TABLE `team_member`
	ADD COLUMN `org_membership_id` varchar(64) NULL AFTER `team_id`;
--> statement-breakpoint
UPDATE `team_member` tm
	INNER JOIN `team` t ON t.`id` = tm.`team_id`
	INNER JOIN `member` m ON m.`organization_id` = t.`organization_id` AND m.`user_id` = tm.`user_id`
SET tm.`org_membership_id` = m.`id`
WHERE tm.`org_membership_id` IS NULL;
--> statement-breakpoint
DROP INDEX `team_member_team_user` ON `team_member`;
--> statement-breakpoint
DROP INDEX `team_member_user_id` ON `team_member`;
--> statement-breakpoint
ALTER TABLE `team_member`
	MODIFY COLUMN `org_membership_id` varchar(64) NOT NULL;
--> statement-breakpoint
CREATE INDEX `team_member_org_membership_id` ON `team_member` (`org_membership_id`);
--> statement-breakpoint
ALTER TABLE `team_member`
	ADD CONSTRAINT `team_member_team_org_membership` UNIQUE(`team_id`, `org_membership_id`);
--> statement-breakpoint
ALTER TABLE `team_member`
	DROP COLUMN `user_id`;
--> statement-breakpoint
CREATE TABLE `skill` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`skill_text` text NOT NULL,
	`shared` enum('org','public'),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `skill_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_organization_id` ON `skill` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `skill_created_by_org_membership_id` ON `skill` (`created_by_org_membership_id`);
--> statement-breakpoint
CREATE INDEX `skill_shared` ON `skill` (`shared`);
--> statement-breakpoint
CREATE TABLE `skill_hub` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `skill_hub_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_hub_organization_id` ON `skill_hub` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `skill_hub_created_by_org_membership_id` ON `skill_hub` (`created_by_org_membership_id`);
--> statement-breakpoint
CREATE TABLE `skill_hub_skill` (
	`id` varchar(64) NOT NULL,
	`skill_hub_id` varchar(64) NOT NULL,
	`skill_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `skill_hub_skill_id` PRIMARY KEY(`id`),
	CONSTRAINT `skill_hub_skill_hub_skill` UNIQUE(`skill_hub_id`, `skill_id`)
);
--> statement-breakpoint
CREATE INDEX `skill_hub_skill_skill_hub_id` ON `skill_hub_skill` (`skill_hub_id`);
--> statement-breakpoint
CREATE INDEX `skill_hub_skill_skill_id` ON `skill_hub_skill` (`skill_id`);
--> statement-breakpoint
CREATE TABLE `skill_hub_member` (
	`id` varchar(64) NOT NULL,
	`skill_hub_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `skill_hub_member_id` PRIMARY KEY(`id`),
	CONSTRAINT `skill_hub_member_hub_org_membership` UNIQUE(`skill_hub_id`, `org_membership_id`),
	CONSTRAINT `skill_hub_member_hub_team` UNIQUE(`skill_hub_id`, `team_id`)
);
--> statement-breakpoint
CREATE INDEX `skill_hub_member_skill_hub_id` ON `skill_hub_member` (`skill_hub_id`);
--> statement-breakpoint
CREATE INDEX `skill_hub_member_org_membership_id` ON `skill_hub_member` (`org_membership_id`);
--> statement-breakpoint
CREATE INDEX `skill_hub_member_team_id` ON `skill_hub_member` (`team_id`);
