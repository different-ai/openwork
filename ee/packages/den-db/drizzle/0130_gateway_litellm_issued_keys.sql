CREATE TABLE `gateway_litellm_issued_keys` (
	`gateway_provider_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`slot` varchar(191) NOT NULL,
	`status` varchar(32) NOT NULL,
	`message` text,
	`litellm_user_id` varchar(255),
	`litellm_team_id` varchar(255),
	`litellm_token_id` varchar(128),
	`mirrored_from_token_id` varchar(128),
	`source_fingerprint` varchar(64),
	`credential_set_id` varchar(64),
	`credential_id` varchar(64),
	`model_group_id` varchar(64),
	`access_grant_id` varchar(64),
	`checked_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_litellm_issued_keys_pk` PRIMARY KEY(`gateway_provider_id`,`org_membership_id`,`slot`)
);
--> statement-breakpoint
CREATE INDEX `gateway_litellm_issued_keys_member` ON `gateway_litellm_issued_keys` (`org_membership_id`);