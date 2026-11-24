CREATE TABLE `agent_permission_policy` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`team_id` varchar(64),
	`scope_key` varchar(64) NOT NULL,
	`updated_by_org_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `agent_permission_policy_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_permission_policy_scope` UNIQUE(`organization_id`,`scope_key`)
);
--> statement-breakpoint
CREATE TABLE `agent_permission_setting` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`policy_id` varchar(64) NOT NULL,
	`permission_key` varchar(64) NOT NULL,
	`decision` enum('allow','ask','deny'),
	`allow_patterns` json NOT NULL DEFAULT (json_array()),
	`block_patterns` json NOT NULL DEFAULT (json_array()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `agent_permission_setting_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_permission_setting_policy_key` UNIQUE(`policy_id`,`permission_key`)
);
--> statement-breakpoint
CREATE INDEX `agent_permission_policy_team_id` ON `agent_permission_policy` (`team_id`);--> statement-breakpoint
CREATE INDEX `agent_permission_setting_organization_id` ON `agent_permission_setting` (`organization_id`);