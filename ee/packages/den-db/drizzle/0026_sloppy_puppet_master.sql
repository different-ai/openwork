CREATE TABLE `workspace_bootstrap` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`setup_member_id` varchar(64) NOT NULL,
	`device_public_key` text,
	`device_key_fingerprint` varchar(128),
	`status` varchar(32) NOT NULL DEFAULT 'provisional',
	`expires_at` timestamp(3) NOT NULL,
	`claimed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_bootstrap_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_claim` (
	`id` varchar(64) NOT NULL,
	`bootstrap_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`role` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`expires_at` timestamp(3) NOT NULL,
	`claimed_by_user_id` varchar(64),
	`claimed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_claim_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_claim_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `workspace_bootstrap_organization_id` ON `workspace_bootstrap` (`organization_id`);--> statement-breakpoint
CREATE INDEX `workspace_bootstrap_status` ON `workspace_bootstrap` (`status`);--> statement-breakpoint
CREATE INDEX `workspace_bootstrap_expires_at` ON `workspace_bootstrap` (`expires_at`);--> statement-breakpoint
CREATE INDEX `workspace_claim_bootstrap_id` ON `workspace_claim` (`bootstrap_id`);--> statement-breakpoint
CREATE INDEX `workspace_claim_organization_id` ON `workspace_claim` (`organization_id`);--> statement-breakpoint
CREATE INDEX `workspace_claim_status` ON `workspace_claim` (`status`);--> statement-breakpoint
CREATE INDEX `workspace_claim_expires_at` ON `workspace_claim` (`expires_at`);