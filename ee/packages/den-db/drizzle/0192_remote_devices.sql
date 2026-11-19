CREATE TABLE `remote_device_event` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`device_id` varchar(64) NOT NULL,
	`type` varchar(32) NOT NULL,
	`level` varchar(8) NOT NULL,
	`message` varchar(300) NOT NULL,
	`actor` varchar(16) NOT NULL,
	`actor_id` varchar(64),
	`data` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `remote_device_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `remote_device` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`owner_member_id` varchar(64),
	`created_by_member_id` varchar(64),
	`kind` varchar(16) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`source` varchar(16) NOT NULL,
	`platform` varchar(16),
	`external_id` varchar(191) NOT NULL,
	`label` varchar(120) NOT NULL,
	`state` varchar(24) NOT NULL DEFAULT 'unknown',
	`status_detail` varchar(300),
	`app_version` varchar(80),
	`workbot_chat` varchar(96),
	`diagnostics` json,
	`last_seen_at` timestamp(3),
	`removed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `remote_device_id` PRIMARY KEY(`id`),
	CONSTRAINT `remote_device_identity` UNIQUE(`organization_id`,`provider`,`external_id`)
);
--> statement-breakpoint
CREATE INDEX `remote_device_event_device` ON `remote_device_event` (`device_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `remote_device_event_organization` ON `remote_device_event` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `remote_device_owner` ON `remote_device` (`organization_id`,`owner_member_id`);--> statement-breakpoint
CREATE INDEX `remote_device_seen` ON `remote_device` (`last_seen_at`);