CREATE TABLE `cli_connector` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`catalog_key` varchar(128) NOT NULL,
	`name` varchar(255) NOT NULL,
	`manifest_version` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cli_connector_id` PRIMARY KEY(`id`),
	CONSTRAINT `cli_connector_org_catalog` UNIQUE(`organization_id`,`catalog_key`)
);
--> statement-breakpoint
CREATE INDEX `cli_connector_organization_id` ON `cli_connector` (`organization_id`);