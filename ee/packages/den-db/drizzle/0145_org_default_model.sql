CREATE TABLE IF NOT EXISTS `org_default_model` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`team_id` varchar(64),
	`scope_key` varchar(64) NOT NULL,
	`provider_id` varchar(128) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`updated_by_org_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `org_default_model_id` PRIMARY KEY(`id`),
	CONSTRAINT `org_default_model_scope` UNIQUE(`organization_id`,`scope_key`),
	INDEX `org_default_model_team_id` (`team_id`)
);
