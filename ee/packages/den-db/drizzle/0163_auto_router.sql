CREATE TABLE `auto_router_reasoning` (
	`organization_id` varchar(64) NOT NULL,
	`tool_call_id` varchar(191) NOT NULL,
	`payload` mediumtext NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `auto_router_reasoning_call` PRIMARY KEY(`organization_id`,`tool_call_id`)
);
--> statement-breakpoint
CREATE TABLE `auto_router_route` (
	`id` varchar(64) NOT NULL,
	`auto_router_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`gateway_provider_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`prompt` text NOT NULL,
	`thinking_levels` json NOT NULL,
	`position` int unsigned NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `auto_router_route_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auto_router` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`updated_by_org_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `auto_router_id` PRIMARY KEY(`id`),
	CONSTRAINT `auto_router_organization` UNIQUE(`organization_id`)
);
--> statement-breakpoint
CREATE INDEX `auto_router_reasoning_expires` ON `auto_router_reasoning` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auto_router_route_router` ON `auto_router_route` (`auto_router_id`,`position`);--> statement-breakpoint
CREATE INDEX `auto_router_route_organization` ON `auto_router_route` (`organization_id`);