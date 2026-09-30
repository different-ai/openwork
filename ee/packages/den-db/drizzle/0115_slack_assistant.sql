CREATE TABLE `slack_assistant_event` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`slack_user_id` varchar(64) NOT NULL,
	`channel_id` varchar(64) NOT NULL,
	`thread_ts` varchar(64) NOT NULL,
	`payload` mediumtext NOT NULL,
	`checkpoint` mediumtext,
	`status` varchar(24) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`lease_until` timestamp(3),
	`lease_owner` varchar(64),
	`cancelled` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `slack_assistant_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `slack_assistant_identity` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`slack_user_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `slack_assistant_identity_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_assistant_identity_actor` UNIQUE(`connection_id`,`team_id`,`slack_user_id`),
	CONSTRAINT `slack_assistant_identity_member` UNIQUE(`connection_id`,`member_id`)
);
--> statement-breakpoint
CREATE TABLE `slack_assistant_installation` (
	`connection_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`signing_secret` text NOT NULL,
	`team_id` varchar(64),
	`app_id` varchar(64),
	`bot_user_id` varchar(64),
	`bot_token` text,
	`channel_ids` json,
	`shadow_mode` boolean NOT NULL DEFAULT false,
	`daily_limit` int NOT NULL DEFAULT 100,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `slack_assistant_installation_connection_id` PRIMARY KEY(`connection_id`),
	CONSTRAINT `slack_assistant_team` UNIQUE(`team_id`)
);
--> statement-breakpoint
CREATE TABLE `slack_assistant_oauth_state` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `slack_assistant_oauth_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `slack_assistant_thread` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`channel_id` varchar(64) NOT NULL,
	`thread_ts` varchar(64) NOT NULL,
	`session_id` varchar(240),
	`workspace_id` varchar(240),
	`active_event_id` varchar(64),
	CONSTRAINT `slack_assistant_thread_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `slack_assistant_event_queue` ON `slack_assistant_event` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `slack_assistant_event_actor` ON `slack_assistant_event` (`connection_id`,`slack_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `slack_assistant_oauth_expiry` ON `slack_assistant_oauth_state` (`expires_at`);--> statement-breakpoint
CREATE INDEX `slack_assistant_thread_member` ON `slack_assistant_thread` (`connection_id`,`member_id`);