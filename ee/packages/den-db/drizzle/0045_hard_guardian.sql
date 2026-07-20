CREATE TABLE `plugin_mcp_server_instance` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`plugin_id` varchar(64) NOT NULL,
	`config_object_id` varchar(64),
	`server_key` varchar(128) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`instance_label` varchar(255),
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `plugin_mcp_server_instance_id` PRIMARY KEY(`id`),
	CONSTRAINT `plugin_mcp_server_instance_connection` UNIQUE(`external_mcp_connection_id`)
);
--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `config_values` text;--> statement-breakpoint
ALTER TABLE `config_object` ADD `den_skill_id` varchar(64);--> statement-breakpoint
CREATE INDEX `plugin_mcp_server_instance_organization_id` ON `plugin_mcp_server_instance` (`organization_id`);--> statement-breakpoint
CREATE INDEX `plugin_mcp_server_instance_plugin_server` ON `plugin_mcp_server_instance` (`plugin_id`,`server_key`);--> statement-breakpoint
CREATE INDEX `plugin_mcp_server_instance_config_object_id` ON `plugin_mcp_server_instance` (`config_object_id`);--> statement-breakpoint
CREATE INDEX `config_object_den_skill_id` ON `config_object` (`den_skill_id`);