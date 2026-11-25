CREATE TABLE `mcp_event_receipt` (
	`id` varchar(80) NOT NULL,
	`subscription_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`payload` mediumtext,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_event_receipt_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mcp_event_subscription` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`session_id` varchar(128) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`name` varchar(256) NOT NULL,
	`arguments` mediumtext NOT NULL,
	`instruction` text NOT NULL,
	`secret` text NOT NULL,
	`callback_url` varchar(2048) NOT NULL,
	`remote_id` varchar(512),
	`model` varchar(512) NOT NULL,
	`scopes` json NOT NULL,
	`status` varchar(16) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_event_subscription_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mcp_event_turn` (
	`token_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`session_id` varchar(128) NOT NULL,
	`model` varchar(512) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `mcp_event_turn_token_id` PRIMARY KEY(`token_id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_event_receipt_subscription` ON `mcp_event_receipt` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `mcp_event_receipt_queue` ON `mcp_event_receipt` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `mcp_event_receipt_outcomes` ON `mcp_event_receipt` (`created_at`,`organization_id`);--> statement-breakpoint
CREATE INDEX `mcp_event_subscription_thread` ON `mcp_event_subscription` (`organization_id`,`member_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `mcp_event_subscription_expiry` ON `mcp_event_subscription` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mcp_event_turn_expiry` ON `mcp_event_turn` (`expires_at`);