-- Anonymous definitions reused from #4621 (401267fc), atop this branch's
-- 0093_free_inference_allowance, not the reference branch's 0093 snapshot.
-- Installation spend is weekly; desktop proof nonces are new in this follow-up.
CREATE TABLE `anonymous_inference_control` (
	`id` varchar(64) NOT NULL,
	`blocked` boolean NOT NULL DEFAULT false,
	`blocked_at` timestamp(3),
	`block_reason` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `anonymous_inference_control_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_rate_buckets` (
	`id` varchar(64) NOT NULL,
	`kind` enum('session','request') NOT NULL,
	`scope` enum('installation','ip','global') NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `anonymous_inference_rate_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `anonymous_inference_rate_bucket_identity_window` UNIQUE(`kind`,`scope`,`identity_hash`,`window_start_at`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_reservation_charges` (
	`id` varchar(64) NOT NULL,
	`reservation_id` varchar(64) NOT NULL,
	`bucket_id` varchar(64) NOT NULL,
	`reserved_micro_usd` bigint NOT NULL,
	`settled_micro_usd` bigint,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `anonymous_inference_reservation_charges_id` PRIMARY KEY(`id`),
	CONSTRAINT `anonymous_inference_reservation_charge_bucket` UNIQUE(`reservation_id`,`bucket_id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_reservations` (
	`id` varchar(64) NOT NULL,
	`installation_hash` varchar(64) NOT NULL,
	`ip_hash` varchar(64) NOT NULL,
	`status` enum('active','settled','retained') NOT NULL DEFAULT 'active',
	`reserved_micro_usd` bigint NOT NULL,
	`settled_micro_usd` bigint,
	`lease_expires_at` timestamp(3) NOT NULL,
	`released_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `anonymous_inference_reservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `anonymous_inference_usage_buckets` (
	`id` varchar(64) NOT NULL,
	`scope` enum('installation','ip','global') NOT NULL,
	`identity_hash` varchar(64) NOT NULL,
	`window_type` enum('daily','monthly','weekly') NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_micro_usd` bigint NOT NULL,
	`used_micro_usd` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `anonymous_inference_usage_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `anonymous_inference_usage_bucket_identity_window` UNIQUE(`scope`,`identity_hash`,`window_type`,`window_start_at`)
);
--> statement-breakpoint
CREATE TABLE `desktop_free_proof_nonces` (
	`id` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `desktop_free_proof_nonces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `anonymous_inference_rate_bucket_window_end` ON `anonymous_inference_rate_buckets` (`window_end_at`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_reservation_charge_bucket_id` ON `anonymous_inference_reservation_charges` (`bucket_id`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_reservation_active_installation` ON `anonymous_inference_reservations` (`status`,`installation_hash`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_reservation_active_lease` ON `anonymous_inference_reservations` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `anonymous_inference_usage_bucket_window_end` ON `anonymous_inference_usage_buckets` (`window_end_at`);--> statement-breakpoint
CREATE INDEX `desktop_free_proof_nonce_expiry` ON `desktop_free_proof_nonces` (`expires_at`);--> statement-breakpoint
INSERT INTO `anonymous_inference_control` (`id`, `blocked`) VALUES ('anonymous-inference-global', false);
