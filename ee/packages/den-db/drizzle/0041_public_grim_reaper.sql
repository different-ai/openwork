CREATE TABLE IF NOT EXISTS `plugin_import_source` (
	`plugin_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider` enum('github') NOT NULL,
	`canonical_source_key` varchar(64) NOT NULL,
	`canonical_source_url` varchar(2048) NOT NULL,
	`source_revision_ref` varchar(255),
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `plugin_import_source_plugin_id` PRIMARY KEY(`plugin_id`),
	CONSTRAINT `plugin_import_source_org_provider_key` UNIQUE(`organization_id`,`provider`,`canonical_source_key`),
	INDEX `plugin_import_source_organization_id` (`organization_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plugin_managed_external_mcp_connection` (
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_plugin_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `plugin_managed_mcp_connection_pk` PRIMARY KEY(`external_mcp_connection_id`),
	INDEX `plugin_managed_mcp_connection_organization_id` (`organization_id`),
	INDEX `plugin_managed_mcp_connection_created_by_plugin_id` (`created_by_plugin_id`)
);
--> statement-breakpoint
INSERT IGNORE INTO `plugin_import_source` (
	`plugin_id`,
	`organization_id`,
	`provider`,
	`canonical_source_key`,
	`canonical_source_url`,
	`source_revision_ref`,
	`created_by_org_membership_id`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`organization_id`,
	'github',
	SHA2(SUBSTRING(
		`description`,
		CHAR_LENGTH('Plugin components imported from ') + 1,
		CHAR_LENGTH(`description`) - CHAR_LENGTH('Plugin components imported from ') - 1
	), 256),
	SUBSTRING(
		`description`,
		CHAR_LENGTH('Plugin components imported from ') + 1,
		CHAR_LENGTH(`description`) - CHAR_LENGTH('Plugin components imported from ') - 1
	),
	NULL,
	`created_by_org_membership_id`,
	`created_at`,
	`updated_at`
FROM `plugin`
WHERE `description` LIKE 'Plugin components imported from https://github.com/%.';
