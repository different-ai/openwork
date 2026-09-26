CREATE TABLE `workspace_claim_code` (
	`id` varchar(64) NOT NULL,
	`bootstrap_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_code_hash` varchar(128) NOT NULL,
	`state` varchar(32) NOT NULL DEFAULT 'pending',
	`expires_at` timestamp(3) NOT NULL,
	`claimed_by_user_id` varchar(64),
	`accepted_at` timestamp(3),
	`reconciled_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_claim_code_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_claim_code_user_code_hash` UNIQUE(`user_code_hash`)
);
--> statement-breakpoint
ALTER TABLE `workspace_bootstrap` ADD `agent_user_id` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_bootstrap` ADD `assertion_jti` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_bootstrap` ADD `credentials_revoked_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `workspace_claim_code_bootstrap_id` ON `workspace_claim_code` (`bootstrap_id`);--> statement-breakpoint
CREATE INDEX `workspace_claim_code_state` ON `workspace_claim_code` (`state`);--> statement-breakpoint
CREATE INDEX `workspace_bootstrap_agent_user_id` ON `workspace_bootstrap` (`agent_user_id`);