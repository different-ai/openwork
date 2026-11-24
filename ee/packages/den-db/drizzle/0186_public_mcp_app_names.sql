CREATE TABLE `public_mcp_app_name` (
	`name` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`config_object_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `public_mcp_app_name_name` PRIMARY KEY(`name`),
	CONSTRAINT `public_mcp_app_name_config_object_id` UNIQUE(`config_object_id`)
);
--> statement-breakpoint
CREATE INDEX `public_mcp_app_name_organization_id` ON `public_mcp_app_name` (`organization_id`);