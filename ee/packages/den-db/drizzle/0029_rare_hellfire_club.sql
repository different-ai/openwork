CREATE TABLE `external_mcp_connection_access_grant` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`org_wide` boolean NOT NULL DEFAULT false,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `external_mcp_connection_access_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `emc_access_grant_connection_member` UNIQUE(`external_mcp_connection_id`,`org_membership_id`),
	CONSTRAINT `emc_access_grant_connection_team` UNIQUE(`external_mcp_connection_id`,`team_id`)
);
--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `credential_mode` enum('shared','per_member') DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `access_token` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `refresh_token` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `token_type` varchar(64);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `scope` varchar(1024);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `expires_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `pending_code_verifier` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `connected_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `emc_access_grant_organization_id` ON `external_mcp_connection_access_grant` (`organization_id`);--> statement-breakpoint
CREATE INDEX `emc_access_grant_connection_id` ON `external_mcp_connection_access_grant` (`external_mcp_connection_id`);--> statement-breakpoint
CREATE INDEX `emc_access_grant_org_membership_id` ON `external_mcp_connection_access_grant` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `emc_access_grant_team_id` ON `external_mcp_connection_access_grant` (`team_id`);