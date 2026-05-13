CREATE TABLE `inference_keys` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`name` varchar(255),
	`key_hash` varchar(255) NOT NULL,
	`key_prefix` varchar(32),
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`revoked_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_keys_key_hash` UNIQUE(`key_hash`)
);
--> statement-breakpoint
CREATE TABLE `inference_org_limit_policies` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`window_type` enum('five_hour','weekly','monthly') NOT NULL,
	`limit_amount` bigint NOT NULL,
	`reset_strategy` enum('anchored','activity_based') NOT NULL,
	`anchor_at` timestamp(3),
	`current_bucket_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_org_limit_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_org_limit_policies_org_window_type` UNIQUE(`organization_id`,`window_type`)
);
--> statement-breakpoint
CREATE TABLE `inference_org_upstream_provider_keys` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL DEFAULT 'openrouter',
	`external_key_hash` varchar(255),
	`external_workspace_id` varchar(255),
	`encrypted_api_key` text NOT NULL,
	`key_prefix` varchar(32),
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`revoked_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_org_upstream_provider_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_org_upstream_provider_keys_org_provider` UNIQUE(`organization_id`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `inference_org_usage_buckets` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`policy_id` varchar(64) NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_org_usage_buckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inference_usage_ledger_bucket_charges` (
	`id` varchar(64) NOT NULL,
	`ledger_entry_id` varchar(64) NOT NULL,
	`bucket_id` varchar(64) NOT NULL,
	`amount` bigint NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_usage_ledger_bucket_charges_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_usage_ledger_bucket_charges_entry_bucket` UNIQUE(`ledger_entry_id`,`bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `inference_usage_ledger_entries` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`inference_key_id` varchar(64),
	`external_job_id` varchar(255) NOT NULL,
	`external_event_id` varchar(255),
	`cost_amount` bigint NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`occurred_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_usage_ledger_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_usage_ledger_entries_external_event_id` UNIQUE(`external_event_id`),
	CONSTRAINT `inference_usage_ledger_entries_job_event_type` UNIQUE(`external_job_id`,`event_type`)
);
--> statement-breakpoint
ALTER TABLE `llm_provider` MODIFY COLUMN `source` enum('models_dev','custom','openwork') NOT NULL;--> statement-breakpoint
CREATE INDEX `inference_keys_organization_id` ON `inference_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `inference_keys_org_membership_id` ON `inference_keys` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `inference_keys_status` ON `inference_keys` (`status`);--> statement-breakpoint
CREATE INDEX `inference_org_limit_policies_organization_id` ON `inference_org_limit_policies` (`organization_id`);--> statement-breakpoint
CREATE INDEX `inference_org_upstream_provider_keys_organization_id` ON `inference_org_upstream_provider_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `inference_org_upstream_provider_keys_external_key_hash` ON `inference_org_upstream_provider_keys` (`external_key_hash`);--> statement-breakpoint
CREATE INDEX `inference_org_upstream_provider_keys_status` ON `inference_org_upstream_provider_keys` (`status`);--> statement-breakpoint
CREATE INDEX `inference_org_usage_buckets_org_window` ON `inference_org_usage_buckets` (`organization_id`,`window_start_at`,`window_end_at`);--> statement-breakpoint
CREATE INDEX `inference_org_usage_buckets_policy_id` ON `inference_org_usage_buckets` (`policy_id`);--> statement-breakpoint
CREATE INDEX `inference_org_usage_buckets_policy_window` ON `inference_org_usage_buckets` (`policy_id`,`window_start_at`,`window_end_at`);--> statement-breakpoint
CREATE INDEX `inference_usage_ledger_bucket_charges_bucket_id` ON `inference_usage_ledger_bucket_charges` (`bucket_id`);--> statement-breakpoint
CREATE INDEX `inference_usage_ledger_entries_organization_id` ON `inference_usage_ledger_entries` (`organization_id`);--> statement-breakpoint
CREATE INDEX `inference_usage_ledger_entries_org_membership_id` ON `inference_usage_ledger_entries` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `inference_usage_ledger_entries_inference_key_id` ON `inference_usage_ledger_entries` (`inference_key_id`);
