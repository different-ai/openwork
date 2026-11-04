CREATE TABLE `public_mcp_app` (
	`id` varchar(64) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`config_object_id` varchar(64) NOT NULL,
	`config_object_version_id` varchar(64) NOT NULL,
	`published_by_org_membership_id` varchar(64) NOT NULL,
	`published_at` timestamp(3) NOT NULL DEFAULT (now()),
	`unpublished_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `public_mcp_app_id` PRIMARY KEY(`id`),
	CONSTRAINT `public_mcp_app_config_object_id` UNIQUE(`config_object_id`),
	CONSTRAINT `public_mcp_app_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE INDEX `public_mcp_app_organization_id` ON `public_mcp_app` (`organization_id`);