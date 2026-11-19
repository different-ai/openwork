-- Smart Routers replace the single Auto Router; earlier Auto Router settings are dropped on purpose (the feature was off by default).
DELETE FROM `auto_router`;--> statement-breakpoint
DELETE FROM `auto_router_reasoning`;--> statement-breakpoint
CREATE TABLE `auto_router_access` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`auto_router_id` varchar(64) NOT NULL,
	`org_wide` boolean NOT NULL DEFAULT false,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `auto_router_access_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auto_router_model` (
	`id` varchar(64) NOT NULL,
	`auto_router_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`gateway_provider_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`position` int unsigned NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `auto_router_model_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auto_router_model_task` (
	`auto_router_model_id` varchar(64) NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`position` int unsigned NOT NULL,
	CONSTRAINT `auto_router_model_task_pk` PRIMARY KEY(`auto_router_model_id`,`task_id`)
);
--> statement-breakpoint
CREATE TABLE `auto_router_task` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`name_key` varchar(255) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `auto_router_task_id` PRIMARY KEY(`id`),
	CONSTRAINT `auto_router_task_organization_name` UNIQUE(`organization_id`,`name_key`)
);
--> statement-breakpoint
DROP TABLE `auto_router_route`;--> statement-breakpoint
ALTER TABLE `auto_router` DROP INDEX `auto_router_organization`;--> statement-breakpoint
ALTER TABLE `auto_router` ADD `name` varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE `auto_router` ADD `created_by_org_member_id` varchar(64);--> statement-breakpoint
CREATE INDEX `auto_router_access_organization` ON `auto_router_access` (`organization_id`);--> statement-breakpoint
CREATE INDEX `auto_router_access_router` ON `auto_router_access` (`auto_router_id`);--> statement-breakpoint
CREATE INDEX `auto_router_access_member` ON `auto_router_access` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `auto_router_access_team` ON `auto_router_access` (`team_id`);--> statement-breakpoint
CREATE INDEX `auto_router_model_router` ON `auto_router_model` (`auto_router_id`,`position`);--> statement-breakpoint
CREATE INDEX `auto_router_model_organization` ON `auto_router_model` (`organization_id`);--> statement-breakpoint
CREATE INDEX `auto_router_model_task_task` ON `auto_router_model_task` (`task_id`);--> statement-breakpoint
CREATE INDEX `auto_router_model_task_organization` ON `auto_router_model_task` (`organization_id`);--> statement-breakpoint
CREATE INDEX `auto_router_organization` ON `auto_router` (`organization_id`);--> statement-breakpoint
ALTER TABLE `auto_router` DROP COLUMN `enabled`;