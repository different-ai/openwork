CREATE TABLE `cloud_coding_access_grant` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `cloud_coding_access_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_coding_access_grant_member` UNIQUE(`organization_id`,`org_membership_id`),
	CONSTRAINT `cloud_coding_access_grant_team` UNIQUE(`organization_id`,`team_id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_coding_github_link` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`github_user_id` bigint unsigned NOT NULL,
	`github_login` varchar(255) NOT NULL,
	`github_name` varchar(255),
	`commit_email` varchar(320) NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`access_token_expires_at` timestamp(3),
	`refresh_token_expires_at` timestamp(3),
	`linked_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_github_link_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_coding_github_link_member` UNIQUE(`org_membership_id`),
	CONSTRAINT `cloud_coding_github_link_org_github_user` UNIQUE(`organization_id`,`github_user_id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_coding_installation` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`github_installation_id` bigint unsigned NOT NULL,
	`account_id` bigint unsigned NOT NULL,
	`account_login` varchar(255) NOT NULL,
	`account_type` enum('Organization','User') NOT NULL,
	`repository_selection` enum('all','selected') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`access_org_wide` boolean NOT NULL DEFAULT true,
	`suspended_at` timestamp(3),
	`connected_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_installation_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_coding_installation_org` UNIQUE(`organization_id`),
	CONSTRAINT `cloud_coding_installation_github` UNIQUE(`github_installation_id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_coding_pull_request` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`opened_by_org_membership_id` varchar(64) NOT NULL,
	`opened_by_name` varchar(255) NOT NULL,
	`approval_id` varchar(64) NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`github_repository_id` bigint unsigned NOT NULL,
	`repository_full_name` varchar(255) NOT NULL,
	`number` int unsigned NOT NULL,
	`title` varchar(512) NOT NULL,
	`url` varchar(1024) NOT NULL,
	`branch` varchar(255) NOT NULL,
	`head_sha` varchar(40) NOT NULL,
	`state` enum('open','merged','closed') NOT NULL DEFAULT 'open',
	`opened_at` timestamp(3) NOT NULL DEFAULT (now()),
	`merged_at` timestamp(3),
	`closed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_pull_request_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_coding_pull_request_number` UNIQUE(`organization_id`,`github_repository_id`,`number`),
	CONSTRAINT `cloud_coding_pull_request_approval` UNIQUE(`approval_id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_coding_push_approval` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`github_repository_id` bigint unsigned NOT NULL,
	`repository_full_name` varchar(255) NOT NULL,
	`branch` varchar(255) NOT NULL,
	`base_branch` varchar(255) NOT NULL,
	`base_sha` varchar(40) NOT NULL,
	`tree_sha` varchar(40) NOT NULL,
	`head_sha` varchar(40) NOT NULL,
	`commit_time` int unsigned NOT NULL,
	`author_name` varchar(255) NOT NULL,
	`author_email` varchar(320) NOT NULL,
	`commit_message` text NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` text,
	`summary` json NOT NULL,
	`status` enum('pending','approved','denied','pushed','expired','superseded') NOT NULL DEFAULT 'pending',
	`decided_at` timestamp(3),
	`pushed_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_push_approval_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_coding_repository` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`installation_id` varchar(64) NOT NULL,
	`github_repository_id` bigint unsigned NOT NULL,
	`full_name` varchar(255) NOT NULL,
	`default_branch` varchar(255),
	`is_private` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_repository_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_coding_repository_org_github` UNIQUE(`organization_id`,`github_repository_id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_coding_task` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`repository_id` varchar(64) NOT NULL,
	`github_repository_id` bigint unsigned NOT NULL,
	`repository_full_name` varchar(255) NOT NULL,
	`base_branch` varchar(255) NOT NULL,
	`title` varchar(255) NOT NULL,
	`status` enum('created','running','awaiting_approval','pushed','pull_request_opened','failed','cancelled') NOT NULL DEFAULT 'created',
	`setup_code_hash` varchar(64),
	`setup_code_expires_at` timestamp(3),
	`token_hash` varchar(64),
	`token_expires_at` timestamp(3),
	`remote_session_id` varchar(128),
	`worker_id` varchar(64),
	`failure_code` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_task_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_coding_task_setup_code` UNIQUE(`setup_code_hash`),
	CONSTRAINT `cloud_coding_task_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `cloud_coding_pull_request_org_opened` ON `cloud_coding_pull_request` (`organization_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `cloud_coding_push_approval_member_status` ON `cloud_coding_push_approval` (`organization_id`,`org_membership_id`,`status`);--> statement-breakpoint
CREATE INDEX `cloud_coding_push_approval_task` ON `cloud_coding_push_approval` (`task_id`);--> statement-breakpoint
CREATE INDEX `cloud_coding_repository_org_name` ON `cloud_coding_repository` (`organization_id`,`full_name`);--> statement-breakpoint
CREATE INDEX `cloud_coding_task_member_status` ON `cloud_coding_task` (`organization_id`,`org_membership_id`,`status`);