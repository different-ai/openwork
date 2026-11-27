CREATE TABLE `mcp_app_storage` (
	`config_object_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`backend` varchar(32) NOT NULL,
	`row_count` int NOT NULL DEFAULT 0,
	`size_bytes` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `mcp_app_storage_config_object_id` PRIMARY KEY(`config_object_id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_app_storage_organization_id` ON `mcp_app_storage` (`organization_id`);