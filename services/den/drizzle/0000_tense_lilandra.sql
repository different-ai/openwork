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
	`userId` varchar(64) NOT NULL,
	`accountId` varchar(255) NOT NULL,
	`providerId` varchar(255) NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`accessTokenExpiresAt` timestamp(3),
	`refreshTokenExpiresAt` timestamp(3),
	`scope` varchar(1024),
	`idToken` text,
	`password` varchar(512),
	`createdAt` timestamp(3) NOT NULL DEFAULT (now()),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(64) NOT NULL,
	`userId` varchar(64) NOT NULL,
	`token` varchar(255) NOT NULL,
	`expiresAt` timestamp(3) NOT NULL,
	`ipAddress` varchar(255),
	`userAgent` varchar(1024),
	`createdAt` timestamp(3) NOT NULL DEFAULT (now()),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`emailVerified` boolean NOT NULL DEFAULT false,
	`image` varchar(2048),
	`createdAt` timestamp(3) NOT NULL DEFAULT (now()),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(64) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`value` varchar(1024) NOT NULL,
	`expiresAt` timestamp(3) NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT (now()),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
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
CREATE INDEX `account_user_id` ON `account` (`userId`);--> statement-breakpoint
CREATE INDEX `account_provider_id` ON `account` (`providerId`);--> statement-breakpoint
CREATE INDEX `account_account_id` ON `account` (`accountId`);--> statement-breakpoint
CREATE INDEX `session_user_id` ON `session` (`userId`);--> statement-breakpoint
CREATE INDEX `verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `org_membership_org_id` ON `org_membership` (`org_id`);--> statement-breakpoint
CREATE INDEX `org_membership_user_id` ON `org_membership` (`user_id`);--> statement-breakpoint
CREATE INDEX `org_owner_user_id` ON `org` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `worker_bundle_worker_id` ON `worker_bundle` (`worker_id`);--> statement-breakpoint
CREATE INDEX `worker_instance_worker_id` ON `worker_instance` (`worker_id`);--> statement-breakpoint
CREATE INDEX `worker_org_id` ON `worker` (`org_id`);--> statement-breakpoint
CREATE INDEX `worker_status` ON `worker` (`status`);--> statement-breakpoint
CREATE INDEX `worker_token_worker_id` ON `worker_token` (`worker_id`);
