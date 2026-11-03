-- One idempotent statement per table, indexes inline: PlanetScale applies DDL
-- outside the transaction, so a separate CREATE INDEX that failed would leave
-- the table behind and every retry would hit "table already exists" (see 0145).
CREATE TABLE IF NOT EXISTS `org_prompt` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`content` mediumtext NOT NULL,
	`created_by_org_member_id` varchar(64),
	`updated_by_org_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `org_prompt_id` PRIMARY KEY(`id`),
	INDEX `org_prompt_organization_id` (`organization_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `org_prompt_access` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`prompt_id` varchar(64) NOT NULL,
	`org_wide` boolean NOT NULL DEFAULT false,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `org_prompt_access_id` PRIMARY KEY(`id`),
	CONSTRAINT `org_prompt_access_prompt_member` UNIQUE(`prompt_id`,`org_membership_id`),
	CONSTRAINT `org_prompt_access_prompt_team` UNIQUE(`prompt_id`,`team_id`),
	INDEX `org_prompt_access_organization_id` (`organization_id`),
	INDEX `org_prompt_access_org_membership_id` (`org_membership_id`),
	INDEX `org_prompt_access_team_id` (`team_id`)
);
