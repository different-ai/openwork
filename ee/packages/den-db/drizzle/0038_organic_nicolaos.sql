CREATE TABLE `external_mcp_oauth_transaction` (
	`state_key` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`external_mcp_connection_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`connection_authorization_epoch` int NOT NULL DEFAULT 0,
	`code_verifier` text NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `external_mcp_oauth_transaction_state_key` PRIMARY KEY(`state_key`)
);
--> statement-breakpoint
ALTER TABLE `external_mcp_connection` MODIFY COLUMN `scope` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `requested_oauth_scopes` json;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `oauth_registration_lease_token` varchar(64);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `oauth_registration_lease_started_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `oauth_authorization_epoch` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `external_mcp_oauth_transaction_connection` ON `external_mcp_oauth_transaction` (`external_mcp_connection_id`);--> statement-breakpoint
CREATE INDEX `external_mcp_oauth_transaction_expires_at` ON `external_mcp_oauth_transaction` (`expires_at`);