CREATE TABLE `telegram_chat_binding` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`telegram_chat_id` varchar(32) NOT NULL,
	`telegram_user_id` varchar(32) NOT NULL,
	`telegram_username` varchar(64),
	`telegram_first_name` varchar(255) NOT NULL,
	`worker_workspace_id` varchar(255),
	`worker_session_id` varchar(255),
	`paired_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `telegram_chat_binding_id` PRIMARY KEY(`id`),
	CONSTRAINT `telegram_chat_binding_connection_id` UNIQUE(`connection_id`),
	CONSTRAINT `telegram_chat_binding_connection_chat` UNIQUE(`connection_id`,`telegram_chat_id`)
);
--> statement-breakpoint
CREATE TABLE `telegram_connection` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`bot_token` text NOT NULL,
	`webhook_secret` text NOT NULL,
	`bot_id` varchar(32) NOT NULL,
	`bot_username` varchar(64),
	`bot_display_name` varchar(255) NOT NULL,
	`status` enum('active','error') NOT NULL DEFAULT 'active',
	`webhook_registered` boolean NOT NULL DEFAULT false,
	`dispatch_token` varchar(64),
	`dispatch_started_at` timestamp(3),
	`last_webhook_at` timestamp(3),
	`last_error` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `telegram_connection_id` PRIMARY KEY(`id`),
	CONSTRAINT `telegram_connection_organization_id` UNIQUE(`organization_id`),
	CONSTRAINT `telegram_connection_bot_id` UNIQUE(`bot_id`)
);
--> statement-breakpoint
CREATE TABLE `telegram_pairing` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`used_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `telegram_pairing_id` PRIMARY KEY(`id`),
	CONSTRAINT `telegram_pairing_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `telegram_update` (
	`id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`update_id` varchar(32) NOT NULL,
	`payload` text NOT NULL,
	`status` enum('accepted','processing','completed','ignored','failed') NOT NULL DEFAULT 'accepted',
	`attempts` int NOT NULL DEFAULT 0,
	`processing_token` varchar(64),
	`processing_started_at` timestamp(3),
	`error` text,
	`received_at` timestamp(3) NOT NULL DEFAULT (now()),
	`completed_at` timestamp(3),
	CONSTRAINT `telegram_update_id` PRIMARY KEY(`id`),
	CONSTRAINT `telegram_update_connection_update` UNIQUE(`connection_id`,`update_id`)
);
--> statement-breakpoint
CREATE INDEX `telegram_connection_worker_id` ON `telegram_connection` (`worker_id`);--> statement-breakpoint
CREATE INDEX `telegram_pairing_connection_id` ON `telegram_pairing` (`connection_id`);--> statement-breakpoint
CREATE INDEX `telegram_pairing_expires_at` ON `telegram_pairing` (`expires_at`);--> statement-breakpoint
CREATE INDEX `telegram_update_dispatch` ON `telegram_update` (`status`,`processing_started_at`,`received_at`);--> statement-breakpoint
CREATE INDEX `telegram_update_received_at` ON `telegram_update` (`received_at`);