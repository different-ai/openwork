CREATE TABLE `external_mcp_tool_manifest` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`principal` varchar(64) NOT NULL,
	`config_hash` varchar(64) NOT NULL,
	`status` enum('ok','error') NOT NULL,
	`tools` json NOT NULL,
	`tool_count` int NOT NULL DEFAULT 0,
	`tools_hash` varchar(64),
	`tools_truncated` boolean NOT NULL DEFAULT false,
	`last_error` text,
	`duration_ms` int,
	`listed_at` timestamp(3),
	`stale_at` timestamp(3),
	`refresh_started_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `external_mcp_tool_manifest_id` PRIMARY KEY(`id`),
	CONSTRAINT `emtm_connection_principal` UNIQUE(`external_mcp_connection_id`,`principal`)
);
--> statement-breakpoint
CREATE INDEX `emtm_organization_id` ON `external_mcp_tool_manifest` (`organization_id`);--> statement-breakpoint
CREATE INDEX `emtm_listed_at` ON `external_mcp_tool_manifest` (`listed_at`);--> statement-breakpoint
CREATE INDEX `emtm_refresh_started_at` ON `external_mcp_tool_manifest` (`refresh_started_at`);