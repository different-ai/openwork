-- Safe to run again. The first production run created the table and the
-- deviceCode column, then stopped (PlanetScale's DDL window had not reached
-- every gateway yet) before the indexes and before the migration was
-- recorded. Each statement here is a no-op where it already ran. The
-- deviceCode column and any index missing from a table created by that run
-- are added by ensureSchemaRepairs (src/schema-repairs.ts), which runs after
-- every migrate.
CREATE TABLE IF NOT EXISTS `session_sso_proof` (
	`session_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`sso_provider_id` varchar(255) NOT NULL,
	`authenticated_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `session_sso_proof_pk` PRIMARY KEY(`session_id`,`organization_id`),
	INDEX `session_sso_proof_org` (`organization_id`),
	INDEX `session_sso_proof_user` (`user_id`)
);
--> statement-breakpoint
-- Existing proofs: one per session, earned when the session was created.
INSERT IGNORE INTO `session_sso_proof` (`session_id`, `organization_id`, `user_id`, `sso_provider_id`, `authenticated_at`, `created_at`)
SELECT `session_id`, `organization_id`, `user_id`, `sso_provider_id`, `created_at`, `created_at` FROM `session_sso_authentication`;
