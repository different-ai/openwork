CREATE TABLE `llm_provider_access` (
	`id` varchar(64) NOT NULL,
	`llm_provider_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `llm_provider_access_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_provider_access_provider_org_membership` UNIQUE(`llm_provider_id`,`org_membership_id`),
	CONSTRAINT `llm_provider_access_provider_team` UNIQUE(`llm_provider_id`,`team_id`)
);
--> statement-breakpoint
CREATE TABLE `llm_provider_model` (
	`id` varchar(64) NOT NULL,
	`llm_provider_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`model_config` json NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `llm_provider_model_id` PRIMARY KEY(`id`),
	CONSTRAINT `llm_provider_model_provider_model` UNIQUE(`llm_provider_id`,`model_id`)
);
--> statement-breakpoint
CREATE TABLE `llm_provider` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`source` enum('models_dev','custom') NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`provider_config` json NOT NULL,
	`api_key` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `llm_provider_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `llm_provider_access_llm_provider_id` ON `llm_provider_access` (`llm_provider_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_access_org_membership_id` ON `llm_provider_access` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_access_team_id` ON `llm_provider_access` (`team_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_model_llm_provider_id` ON `llm_provider_model` (`llm_provider_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_model_model_id` ON `llm_provider_model` (`model_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_organization_id` ON `llm_provider` (`organization_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_created_by_org_membership_id` ON `llm_provider` (`created_by_org_membership_id`);--> statement-breakpoint
CREATE INDEX `llm_provider_source` ON `llm_provider` (`source`);--> statement-breakpoint
CREATE INDEX `llm_provider_provider_id` ON `llm_provider` (`provider_id`);