CREATE TABLE `personal_agent_audience` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`team_id` varchar(64),
	`audience_key` varchar(80) NOT NULL,
	`auto_add` boolean NOT NULL DEFAULT false,
	`created_by_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_audience_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_audience_key` UNIQUE(`agent_id`,`audience_key`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_chat` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`workspace_id` varchar(240) NOT NULL,
	`session_id` varchar(240) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_chat_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_chat_member_workspace` UNIQUE(`agent_id`,`member_id`,`workspace_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_event` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64),
	`actor_member_id` varchar(64) NOT NULL,
	`action` varchar(64) NOT NULL,
	`detail` json NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_memory` (
	`agent_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`notes` mediumtext NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`updated_by_member_id` varchar(64),
	`updated_by_run_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_memory_agent_id` PRIMARY KEY(`agent_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_org_policy` (
	`organization_id` varchar(64) NOT NULL,
	`monthly_budget_micros` bigint unsigned,
	`share_mode` enum('everyone','admins') NOT NULL DEFAULT 'everyone',
	`shared_logins` boolean NOT NULL DEFAULT false,
	`updated_by_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_org_policy_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_request` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`status` enum('pending','denied','approved') NOT NULL DEFAULT 'pending',
	`requested_by_member_id` varchar(64) NOT NULL,
	`summary` varchar(500),
	`change` json NOT NULL,
	`decided_by_member_id` varchar(64),
	`decided_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_request_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_revision` (
	`id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`brief` mediumtext NOT NULL,
	`default_execution_target` enum('desktop','cloud') NOT NULL DEFAULT 'cloud',
	`monthly_budget_micros` bigint unsigned,
	`digest` varchar(128) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_revision_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_revision_version` UNIQUE(`agent_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_routine_state` (
	`automation_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`state` mediumtext NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`written_by_agent` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_routine_state_automation_id` PRIMARY KEY(`automation_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_share` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`role` enum('manager','collaborator') NOT NULL,
	`created_by_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_share_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_share_member` UNIQUE(`agent_id`,`member_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent_shared_login` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`agent_id` varchar(64) NOT NULL,
	`connection_id` varchar(160) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_shared_login_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_shared_login_connection` UNIQUE(`agent_id`,`connection_id`)
);
--> statement-breakpoint
CREATE TABLE `personal_agent` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`owner_member_id` varchar(64) NOT NULL,
	`name` varchar(120) NOT NULL,
	`state` enum('active','archived') NOT NULL DEFAULT 'active',
	`current_revision_id` varchar(64) NOT NULL,
	`archived_at` timestamp(3),
	`paused_at` timestamp(3),
	`paused_by_member_id` varchar(64),
	`admin_monthly_budget_micros` bigint unsigned,
	`created_by_member_id` varchar(64),
	`idempotency_key` varchar(128),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `personal_agent_id` PRIMARY KEY(`id`),
	CONSTRAINT `personal_agent_idempotency` UNIQUE(`organization_id`,`created_by_member_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `tool_approval` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`requested_by_member_id` varchar(64) NOT NULL,
	`context_kind` enum('agent','automation','chat') NOT NULL,
	`context_id` varchar(64),
	`context_label` varchar(160),
	`run_id` varchar(64),
	`connection_id` varchar(160) NOT NULL,
	`connection_name` varchar(160) NOT NULL,
	`tool_name` varchar(128) NOT NULL,
	`tool_title` varchar(240) NOT NULL,
	`status` enum('pending','denied','allowed_once','always_allowed','used') NOT NULL DEFAULT 'pending',
	`decided_by_member_id` varchar(64),
	`decided_at` timestamp(3),
	`used_by_run_id` varchar(64),
	`used_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tool_approval_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tool_permission_org_policy` (
	`organization_id` varchar(64) NOT NULL,
	`rules` text,
	`updated_by_member_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tool_permission_org_policy_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `tool_permission_rule` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`subject_kind` enum('organization','team','member','agent') NOT NULL,
	`subject_id` varchar(64) NOT NULL,
	`connection_id` varchar(160) NOT NULL,
	`tool_name` varchar(128) NOT NULL,
	`rule` enum('allow','ask','block') NOT NULL,
	`updated_by_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tool_permission_rule_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `automation_revision` ADD `agent_revision_id` varchar(64);--> statement-breakpoint
ALTER TABLE `automation_run` ADD `acting_member_id` varchar(64);--> statement-breakpoint
ALTER TABLE `automation` ADD `agent_id` varchar(64);--> statement-breakpoint
CREATE INDEX `personal_agent_audience_org_team` ON `personal_agent_audience` (`organization_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `personal_agent_event_org_created` ON `personal_agent_event` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `personal_agent_event_agent` ON `personal_agent_event` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `personal_agent_memory_org` ON `personal_agent_memory` (`organization_id`);--> statement-breakpoint
CREATE INDEX `personal_agent_request_agent_status` ON `personal_agent_request` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `personal_agent_routine_state_agent` ON `personal_agent_routine_state` (`agent_id`);--> statement-breakpoint
CREATE INDEX `personal_agent_share_org_member` ON `personal_agent_share` (`organization_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `personal_agent_shared_login_member` ON `personal_agent_shared_login` (`organization_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `personal_agent_org_owner_state` ON `personal_agent` (`organization_id`,`owner_member_id`,`state`);--> statement-breakpoint
CREATE INDEX `tool_approval_member_status` ON `tool_approval` (`organization_id`,`requested_by_member_id`,`status`);--> statement-breakpoint
CREATE INDEX `tool_approval_context_status` ON `tool_approval` (`organization_id`,`context_kind`,`context_id`,`status`);--> statement-breakpoint
CREATE INDEX `tool_permission_rule_subject` ON `tool_permission_rule` (`organization_id`,`subject_kind`,`subject_id`,`connection_id`);--> statement-breakpoint
CREATE INDEX `tool_permission_rule_connection` ON `tool_permission_rule` (`organization_id`,`connection_id`);--> statement-breakpoint
CREATE INDEX `automation_agent` ON `automation` (`agent_id`);