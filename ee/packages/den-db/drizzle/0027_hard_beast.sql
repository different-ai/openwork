CREATE TABLE `connected_account` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`external_account_id` varchar(255),
	`scopes` json,
	`access_token` text,
	`refresh_token` text,
	`token_type` varchar(64),
	`expires_at` timestamp(3),
	`pending_code_verifier` text,
	`connected_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `connected_account_id` PRIMARY KEY(`id`),
	CONSTRAINT `connected_account_member_provider` UNIQUE(`org_membership_id`,`provider_id`)
);
--> statement-breakpoint
CREATE TABLE `external_mcp_connection` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`url` varchar(2048) NOT NULL,
	`auth_type` enum('oauth','apikey','none') NOT NULL,
	`api_key` text,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `external_mcp_connection_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `org_oauth_client` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`client_id` varchar(512) NOT NULL,
	`client_secret` text,
	`extra` json,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `org_oauth_client_id` PRIMARY KEY(`id`),
	CONSTRAINT `org_oauth_client_org_provider` UNIQUE(`organization_id`,`provider_id`)
);
--> statement-breakpoint
CREATE INDEX `connected_account_organization_id` ON `connected_account` (`organization_id`);--> statement-breakpoint
CREATE INDEX `connected_account_org_membership_id` ON `connected_account` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `external_mcp_connection_organization_id` ON `external_mcp_connection` (`organization_id`);--> statement-breakpoint
CREATE INDEX `org_oauth_client_organization_id` ON `org_oauth_client` (`organization_id`);