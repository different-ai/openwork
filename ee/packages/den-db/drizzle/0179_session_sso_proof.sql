CREATE TABLE `session_sso_proof` (
	`session_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`sso_provider_id` varchar(255) NOT NULL,
	`authenticated_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `session_sso_proof_pk` PRIMARY KEY(`session_id`,`organization_id`)
);
--> statement-breakpoint
ALTER TABLE `deviceCode` ADD `sso_authenticated_at` timestamp(3);--> statement-breakpoint
CREATE INDEX `session_sso_proof_org` ON `session_sso_proof` (`organization_id`);--> statement-breakpoint
CREATE INDEX `session_sso_proof_user` ON `session_sso_proof` (`user_id`);--> statement-breakpoint
-- Existing proofs: one per session, earned when the session was created.
INSERT IGNORE INTO `session_sso_proof` (`session_id`, `organization_id`, `user_id`, `sso_provider_id`, `authenticated_at`, `created_at`)
SELECT `session_id`, `organization_id`, `user_id`, `sso_provider_id`, `created_at`, `created_at` FROM `session_sso_authentication`;