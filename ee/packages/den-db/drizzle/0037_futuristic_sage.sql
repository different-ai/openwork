CREATE TABLE `plugin_mcp_requirement_binding` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`plugin_id` varchar(64) NOT NULL,
	`config_object_id` varchar(64) NOT NULL,
	`server_name` varchar(255) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `plugin_mcp_requirement_binding_id` PRIMARY KEY(`id`),
	CONSTRAINT `plugin_mcp_req_binding_org_plugin_object_server` UNIQUE(`organization_id`,`plugin_id`,`config_object_id`,`server_name`)
);
--> statement-breakpoint
ALTER TABLE `external_mcp_connection_access_grant` DROP INDEX `emc_access_grant_connection_member`;--> statement-breakpoint
ALTER TABLE `external_mcp_connection_access_grant` DROP INDEX `emc_access_grant_connection_team`;--> statement-breakpoint
ALTER TABLE `external_mcp_connection_access_grant` ADD `plugin_mcp_requirement_binding_id` varchar(64);--> statement-breakpoint
ALTER TABLE `external_mcp_connection_access_grant` ADD `source_key` varchar(64) DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_mcp_connection_access_grant` ADD CONSTRAINT `emc_access_grant_connection_member` UNIQUE(`external_mcp_connection_id`,`org_membership_id`,`source_key`);--> statement-breakpoint
ALTER TABLE `external_mcp_connection_access_grant` ADD CONSTRAINT `emc_access_grant_connection_team` UNIQUE(`external_mcp_connection_id`,`team_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `plugin_mcp_req_binding_organization_id` ON `plugin_mcp_requirement_binding` (`organization_id`);--> statement-breakpoint
CREATE INDEX `plugin_mcp_req_binding_plugin_id` ON `plugin_mcp_requirement_binding` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `plugin_mcp_req_binding_config_object_id` ON `plugin_mcp_requirement_binding` (`config_object_id`);--> statement-breakpoint
CREATE INDEX `plugin_mcp_req_binding_connection_id` ON `plugin_mcp_requirement_binding` (`external_mcp_connection_id`);--> statement-breakpoint
CREATE INDEX `emc_access_grant_plugin_mcp_binding_id` ON `external_mcp_connection_access_grant` (`plugin_mcp_requirement_binding_id`);