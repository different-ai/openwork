CREATE TABLE `mcp_native_delivery` (
	`id` varchar(64) NOT NULL,
	`subscription_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`payload` mediumtext,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_native_delivery_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mcp_native_subscription` (
	`id` varchar(64) NOT NULL,
	`identity` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`name` varchar(256) NOT NULL,
	`arguments` text NOT NULL,
	`callback_url` varchar(2048),
	`secret` text,
	`previous_secret` text,
	`rotate_until` timestamp(3),
	`verified_at` timestamp(3),
	`verification_token` varchar(48),
	`verification_until` timestamp(3),
	`thread_watch_id` varchar(64),
	`observation` varchar(64) NOT NULL,
	`sequence` int NOT NULL DEFAULT 0,
	`status` varchar(16) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_native_subscription_id` PRIMARY KEY(`id`),
	CONSTRAINT `mcp_native_subscription_identity` UNIQUE(`identity`)
);
--> statement-breakpoint
ALTER TABLE `mcp_event_subscription` MODIFY COLUMN `connection_id` varchar(64);--> statement-breakpoint
ALTER TABLE `mcp_event_subscription` ADD `source` varchar(16) DEFAULT 'connection' NOT NULL;--> statement-breakpoint
CREATE INDEX `mcp_native_delivery_queue` ON `mcp_native_delivery` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `mcp_native_delivery_subscription` ON `mcp_native_delivery` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `mcp_native_delivery_outcomes` ON `mcp_native_delivery` (`created_at`,`organization_id`);--> statement-breakpoint
CREATE INDEX `mcp_native_subscription_queue` ON `mcp_native_subscription` (`status`,`available_at`);