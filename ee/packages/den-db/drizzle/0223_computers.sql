CREATE TABLE `computer_access` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`device_id` varchar(64) NOT NULL,
	`owner_choice` varchar(8),
	`reported_by_runner_id` varchar(160) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `computer_access_id` PRIMARY KEY(`id`),
	CONSTRAINT `computer_access_device` UNIQUE(`device_id`)
);
--> statement-breakpoint
CREATE TABLE `computer_command` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`source_device_id` varchar(64) NOT NULL,
	`target_device_id` varchar(64) NOT NULL,
	`action` json NOT NULL,
	`scope` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`exit_code` int,
	`output` mediumtext,
	`truncated` boolean,
	`error_code` varchar(64),
	`error_message` varchar(300),
	`refused_layer` varchar(16),
	`expires_at` timestamp(3) NOT NULL,
	`claimed_by_runner_id` varchar(160),
	`claimed_at` timestamp(3),
	`completed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `computer_command_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `computer_grant` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`target_device_id` varchar(64) NOT NULL,
	`source_key` varchar(64) NOT NULL,
	`folders` json NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `computer_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `computer_grant_target_source` UNIQUE(`target_device_id`,`source_key`)
);
--> statement-breakpoint
CREATE INDEX `computer_command_target_status_created` ON `computer_command` (`target_device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `computer_command_organization_created` ON `computer_command` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `computer_grant_organization` ON `computer_grant` (`organization_id`);