CREATE TABLE `anonymous_inference_identities` (
	`id` varchar(64) NOT NULL,
	`first_seen_at` timestamp(3) NOT NULL,
	`last_seen_at` timestamp(3) NOT NULL,
	`active_ms` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `anonymous_inference_identities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_rate_buckets` (
	`id` varchar(64) NOT NULL,
	`used_amount` int NOT NULL DEFAULT 0,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `anonymous_inference_rate_buckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_usage_buckets` (
	`id` varchar(64) NOT NULL,
	`scope` enum('installation','global') NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`window_type` enum('weekly','daily','monthly') NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `anonymous_inference_usage_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `anonymous_inference_usage_identity_window` UNIQUE(`scope`,`identity_hash`,`window_type`,`window_start_at`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_usage` (
	`request_id` varchar(64) NOT NULL,
	`completion_id` varchar(255),
	`principal_hash` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`amount` bigint NOT NULL,
	`input_tokens` int,
	`output_tokens` int,
	`estimated` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `anonymous_inference_usage_request_id` PRIMARY KEY(`request_id`),
	CONSTRAINT `anonymous_inference_usage_completion` UNIQUE(`completion_id`)
);
--> statement-breakpoint
CREATE TABLE `desktop_free_proof_nonces` (
	`id` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `desktop_free_proof_nonces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_usage_buckets` (
	`id` varchar(64) NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `inference_free_usage_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_free_usage_identity_window` UNIQUE(`identity_hash`,`window_start_at`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_usage` (
	`request_id` varchar(64) NOT NULL,
	`completion_id` varchar(255),
	`principal_hash` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`inference_key_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`amount` bigint NOT NULL,
	`input_tokens` int,
	`output_tokens` int,
	`estimated` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_free_usage_request_id` PRIMARY KEY(`request_id`),
	CONSTRAINT `inference_free_usage_completion` UNIQUE(`completion_id`)
);
--> statement-breakpoint
ALTER TABLE `gateway_request_logs` MODIFY COLUMN `route` enum('openwork_openrouter','org_provider','openwork_free') NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` MODIFY COLUMN `route` enum('openwork_openrouter','org_provider','openwork_free') NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_providers` ADD `pinned_model_ids` json DEFAULT (JSON_ARRAY()) NOT NULL;--> statement-breakpoint
CREATE INDEX `anonymous_inference_rate_expiry` ON `anonymous_inference_rate_buckets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_usage_principal_created` ON `anonymous_inference_usage` (`principal_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `desktop_free_proof_nonce_expiry` ON `desktop_free_proof_nonces` (`expires_at`);--> statement-breakpoint
CREATE INDEX `inference_free_usage_principal_created` ON `inference_free_usage` (`principal_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `inference_free_usage_org_created` ON `inference_free_usage` (`organization_id`,`created_at`);