CREATE TABLE `tag_channel` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`slack_channel_id` varchar(32) NOT NULL,
	`slack_channel_name` varchar(255),
	`instructions` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tag_channel_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_channel_connection_channel` UNIQUE(`connection_id`,`slack_channel_id`)
);
--> statement-breakpoint
CREATE TABLE `tag_connection` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`bot_token` text NOT NULL,
	`signing_secret` text NOT NULL,
	`slack_team_id` varchar(32) NOT NULL,
	`slack_team_name` varchar(255) NOT NULL,
	`bot_user_id` varchar(32) NOT NULL,
	`bot_name` varchar(255) NOT NULL,
	`service_name` varchar(80) NOT NULL DEFAULT 'OpenWork',
	`default_instructions` text NOT NULL,
	`allowed_user_ids` text NOT NULL,
	`allow_guests` boolean NOT NULL DEFAULT false,
	`allow_shared_channels` boolean NOT NULL DEFAULT false,
	`status` enum('active','error') NOT NULL DEFAULT 'active',
	`dispatch_token` varchar(64),
	`dispatch_started_at` timestamp(3),
	`last_webhook_at` timestamp(3),
	`last_error` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tag_connection_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_connection_organization_id` UNIQUE(`organization_id`),
	CONSTRAINT `tag_connection_slack_team_id` UNIQUE(`slack_team_id`)
);
--> statement-breakpoint
CREATE TABLE `tag_event` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`slack_event_id` varchar(64) NOT NULL,
	`payload` text NOT NULL,
	`status` enum('accepted','processing','completed','ignored','failed') NOT NULL DEFAULT 'accepted',
	`attempts` int NOT NULL DEFAULT 0,
	`processing_token` varchar(64),
	`processing_started_at` timestamp(3),
	`error` text,
	`received_at` timestamp(3) NOT NULL DEFAULT (now()),
	`completed_at` timestamp(3),
	CONSTRAINT `tag_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_event_connection_event` UNIQUE(`connection_id`,`slack_event_id`)
);
--> statement-breakpoint
CREATE TABLE `tag_run` (
	`id` varchar(64) NOT NULL,
	`thread_id` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`slack_user_id` varchar(32) NOT NULL,
	`prompt` text NOT NULL,
	`response` text,
	`status` enum('accepted','running','completed','failed','cancelled') NOT NULL DEFAULT 'accepted',
	`slack_status_message_ts` varchar(32),
	`error` text,
	`started_at` timestamp(3),
	`completed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tag_run_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_run_event_id` UNIQUE(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `tag_thread` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`enterprise_id` varchar(32),
	`slack_team_id` varchar(32) NOT NULL,
	`slack_channel_id` varchar(32) NOT NULL,
	`slack_thread_ts` varchar(32) NOT NULL,
	`started_by_slack_user_id` varchar(32) NOT NULL,
	`worker_workspace_id` varchar(255),
	`worker_session_id` varchar(255),
	`config_snapshot` text NOT NULL,
	`config_snapshot_hash` varchar(64) NOT NULL,
	`status` enum('active','cancelled') NOT NULL DEFAULT 'active',
	`last_message_at` timestamp(3) NOT NULL DEFAULT (now()),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `tag_thread_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_thread_connection_channel_thread` UNIQUE(`connection_id`,`slack_channel_id`,`slack_thread_ts`)
);
--> statement-breakpoint
CREATE INDEX `tag_channel_connection_id` ON `tag_channel` (`connection_id`);--> statement-breakpoint
CREATE INDEX `tag_connection_worker_id` ON `tag_connection` (`worker_id`);--> statement-breakpoint
CREATE INDEX `tag_event_dispatch` ON `tag_event` (`status`,`processing_started_at`,`received_at`);--> statement-breakpoint
CREATE INDEX `tag_event_received_at` ON `tag_event` (`received_at`);--> statement-breakpoint
CREATE INDEX `tag_run_thread_created` ON `tag_run` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tag_run_status_created` ON `tag_run` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tag_thread_worker_session` ON `tag_thread` (`worker_session_id`);--> statement-breakpoint
CREATE INDEX `tag_thread_last_message_at` ON `tag_thread` (`last_message_at`);