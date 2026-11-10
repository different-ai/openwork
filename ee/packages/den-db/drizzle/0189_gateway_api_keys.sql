-- AI Gateway API keys members create for 3rd party tools (gatewayMemberApiKeys).
-- Only a digest of each key is stored; a key may expire (expires_at). Request logs
-- name the member key that made a request in gateway_api_key_id (nullable, no
-- backfill). Plain DDL only.
CREATE TABLE `gateway_api_keys` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`key_hash` varchar(64) NOT NULL,
	`key_prefix` varchar(32) NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`last_used_at` timestamp(3),
	`expires_at` timestamp(3),
	`revoked_at` timestamp(3),
	`revoked_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_api_keys_key_hash` UNIQUE(`key_hash`)
);
--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD `gateway_api_key_id` varchar(64);--> statement-breakpoint
CREATE INDEX `gateway_api_keys_org_status` ON `gateway_api_keys` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `gateway_api_keys_member_status` ON `gateway_api_keys` (`org_membership_id`,`status`);