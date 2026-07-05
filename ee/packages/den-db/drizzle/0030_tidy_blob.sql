CREATE TABLE `install_link` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`revoked_at` timestamp(3),
	`expires_at` timestamp(3),
	CONSTRAINT `install_link_id` PRIMARY KEY(`id`),
	CONSTRAINT `install_link_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `install_link_organization_id` ON `install_link` (`organization_id`);--> statement-breakpoint
CREATE INDEX `install_link_created_by_user_id` ON `install_link` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `install_link_revoked_at` ON `install_link` (`revoked_at`);--> statement-breakpoint
CREATE INDEX `install_link_expires_at` ON `install_link` (`expires_at`);