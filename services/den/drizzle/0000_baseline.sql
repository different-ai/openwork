CREATE TABLE `admin_allowlist` (
	`id` varchar(64) NOT NULL,
	`email` varchar(255) NOT NULL,
	`note` varchar(255),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `admin_allowlist_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_allowlist_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `audit_event` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`worker_id` varchar(64),
	`actor_user_id` varchar(64) NOT NULL,
	`action` varchar(128) NOT NULL,
	`payload` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` timestamp(3),
	`refresh_token_expires_at` timestamp(3),
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`token` varchar(255) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(64) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `daytona_sandbox` (
	`id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`sandbox_id` varchar(128) NOT NULL,
	`workspace_volume_id` varchar(128) NOT NULL,
	`data_volume_id` varchar(128) NOT NULL,
	`signed_preview_url` varchar(2048) NOT NULL,
	`signed_preview_url_expires_at` timestamp(3) NOT NULL,
	`region` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `daytona_sandbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `daytona_sandbox_worker_id` UNIQUE(`worker_id`),
	CONSTRAINT `daytona_sandbox_sandbox_id` UNIQUE(`sandbox_id`)
);
--> statement-breakpoint
CREATE TABLE `org_membership` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`role` enum('owner','member') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `org_membership_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `org` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`owner_user_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `org_id` PRIMARY KEY(`id`),
	CONSTRAINT `org_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `worker_bundle` (
	`id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`storage_url` varchar(2048) NOT NULL,
	`status` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `worker_bundle_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `worker_instance` (
	`id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`region` varchar(64),
	`url` varchar(2048) NOT NULL,
	`status` enum('provisioning','healthy','failed','stopped') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `worker_instance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `worker` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`created_by_user_id` varchar(64),
	`name` varchar(255) NOT NULL,
	`description` varchar(1024),
	`destination` enum('local','cloud') NOT NULL,
	`status` enum('provisioning','healthy','failed','stopped') NOT NULL,
	`image_version` varchar(128),
	`workspace_path` varchar(1024),
	`sandbox_backend` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `worker_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `worker_token` (
	`id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`scope` enum('client','host') NOT NULL,
	`token` varchar(128) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`revoked_at` timestamp(3),
	CONSTRAINT `worker_token_id` PRIMARY KEY(`id`),
	CONSTRAINT `worker_token_token` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `audit_event_org_id` ON `audit_event` (`org_id`);--> statement-breakpoint
CREATE INDEX `audit_event_worker_id` ON `audit_event` (`worker_id`);--> statement-breakpoint
CREATE INDEX `account_user_id` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_user_id` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `org_membership_org_id` ON `org_membership` (`org_id`);--> statement-breakpoint
CREATE INDEX `org_membership_user_id` ON `org_membership` (`user_id`);--> statement-breakpoint
CREATE INDEX `org_owner_user_id` ON `org` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `worker_bundle_worker_id` ON `worker_bundle` (`worker_id`);--> statement-breakpoint
CREATE INDEX `worker_instance_worker_id` ON `worker_instance` (`worker_id`);--> statement-breakpoint
CREATE INDEX `worker_org_id` ON `worker` (`org_id`);--> statement-breakpoint
CREATE INDEX `worker_created_by_user_id` ON `worker` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `worker_status` ON `worker` (`status`);--> statement-breakpoint
CREATE INDEX `worker_token_worker_id` ON `worker_token` (`worker_id`);