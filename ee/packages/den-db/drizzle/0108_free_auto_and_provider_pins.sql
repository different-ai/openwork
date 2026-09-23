CREATE TABLE `anonymous_inference_control` (
	`id` varchar(64) NOT NULL,
	`blocked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `anonymous_inference_control_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_identities` (
	`id` varchar(64) NOT NULL,
	`first_seen_at` timestamp(3) NOT NULL,
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
CREATE TABLE `anonymous_inference_reservation_charges` (
	`id` varchar(64) NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`bucket_id` varchar(64) NOT NULL,
	`reserved_amount` bigint NOT NULL,
	CONSTRAINT `anonymous_inference_reservation_charges_id` PRIMARY KEY(`id`),
	CONSTRAINT `anonymous_inference_charge_request_bucket` UNIQUE(`request_id`,`bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_reservations` (
	`request_id` varchar(64) NOT NULL,
	`principal_hash` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`status` enum('held','dispatched','settled','retained','cancelled') NOT NULL DEFAULT 'held',
	`reserved_amount` bigint NOT NULL,
	`actual_amount` bigint,
	`max_input_tokens` int NOT NULL,
	`max_output_tokens` int NOT NULL,
	`external_event_id` varchar(255),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `anonymous_inference_reservations_request_id` PRIMARY KEY(`request_id`),
	CONSTRAINT `anonymous_inference_reservation_event` UNIQUE(`external_event_id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_usage_buckets` (
	`id` varchar(64) NOT NULL,
	`scope` enum('installation','ip','global') NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`window_type` enum('weekly','daily','monthly') NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	`reserved_amount` bigint NOT NULL DEFAULT 0,
	`blocked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `anonymous_inference_usage_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `anonymous_inference_usage_identity_window` UNIQUE(`scope`,`identity_hash`,`window_type`,`window_start_at`)
);
--> statement-breakpoint
CREATE TABLE `desktop_free_proof_nonces` (
	`id` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `desktop_free_proof_nonces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_control` (
	`id` varchar(64) NOT NULL,
	`blocked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `inference_free_control_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_rate_buckets` (
	`id` varchar(64) NOT NULL,
	`used_amount` int NOT NULL DEFAULT 0,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `inference_free_rate_buckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_reservation_charges` (
	`id` varchar(64) NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`bucket_id` varchar(64) NOT NULL,
	`reserved_amount` bigint NOT NULL,
	CONSTRAINT `inference_free_reservation_charges_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_free_charge_request_bucket` UNIQUE(`request_id`,`bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_reservations` (
	`request_id` varchar(64) NOT NULL,
	`principal_hash` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`inference_key_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`status` enum('held','dispatched','settled','retained','cancelled') NOT NULL DEFAULT 'held',
	`reserved_amount` bigint NOT NULL,
	`actual_amount` bigint,
	`max_input_tokens` int NOT NULL,
	`max_output_tokens` int NOT NULL,
	`external_event_id` varchar(255),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_free_reservations_request_id` PRIMARY KEY(`request_id`),
	CONSTRAINT `inference_free_reservation_event` UNIQUE(`external_event_id`)
);
--> statement-breakpoint
CREATE TABLE `inference_free_usage_buckets` (
	`id` varchar(64) NOT NULL,
	`scope` enum('member','global') NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`window_type` enum('weekly','daily','monthly') NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	`reserved_amount` bigint NOT NULL DEFAULT 0,
	`blocked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `inference_free_usage_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_free_usage_identity_window` UNIQUE(`scope`,`identity_hash`,`window_type`,`window_start_at`)
);
--> statement-breakpoint
ALTER TABLE `gateway_providers` ADD `pinned_model_ids` json DEFAULT (JSON_ARRAY()) NOT NULL;--> statement-breakpoint
CREATE INDEX `anonymous_inference_rate_expiry` ON `anonymous_inference_rate_buckets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_reservation_principal` ON `anonymous_inference_reservations` (`principal_hash`,`status`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_reservation_expiry` ON `anonymous_inference_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `desktop_free_proof_nonce_expiry` ON `desktop_free_proof_nonces` (`expires_at`);--> statement-breakpoint
CREATE INDEX `inference_free_rate_expiry` ON `inference_free_rate_buckets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `inference_free_reservation_principal` ON `inference_free_reservations` (`principal_hash`,`status`);--> statement-breakpoint
CREATE INDEX `inference_free_reservation_expiry` ON `inference_free_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `inference_free_reservation_org_created` ON `inference_free_reservations` (`organization_id`,`created_at`);