CREATE TABLE `organization_brand_asset` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`version` varchar(64) NOT NULL,
	`extension` varchar(3) NOT NULL,
	`bytes` mediumblob NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `organization_brand_asset_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_brand_asset_version` UNIQUE(`organization_id`,`kind`,`version`,`extension`)
);
--> statement-breakpoint
CREATE INDEX `organization_brand_asset_organization_id` ON `organization_brand_asset` (`organization_id`);