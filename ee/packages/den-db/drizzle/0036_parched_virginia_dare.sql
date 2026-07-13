CREATE TABLE `tag_oauth_state` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`state_hash` varchar(64) NOT NULL,
	`payload` text NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`consumed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `tag_oauth_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_oauth_state_hash` UNIQUE(`state_hash`)
);
--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `install_source` enum('manual','oauth') DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `slack_app_id` varchar(32);--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `slack_enterprise_id` varchar(32);--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `is_enterprise_install` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `oauth_scopes` text;--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `refresh_token` text;--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `token_expires_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `token_refreshed_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `token_refresh_lease` varchar(64);--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `token_refresh_started_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `tag_connection` ADD `revoked_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `tag_oauth_state_expiry` ON `tag_oauth_state` (`expires_at`);--> statement-breakpoint
CREATE INDEX `tag_oauth_state_organization` ON `tag_oauth_state` (`organization_id`);