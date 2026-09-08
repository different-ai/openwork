CREATE TABLE `inference_free_reservations` (
	`request_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`inference_key_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`upstream_model` varchar(255) NOT NULL,
	`reserved_amount` bigint NOT NULL,
	`input_token_cap` int NOT NULL,
	`max_output_tokens` int NOT NULL,
	`input_token_price` bigint NOT NULL,
	`output_token_price` bigint NOT NULL,
	`actual_amount` bigint,
	`external_event_id` varchar(255),
	`status` enum('held','settled','invalid') NOT NULL DEFAULT 'held',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`settled_at` timestamp(3),
	CONSTRAINT `inference_free_reservations_request_id` PRIMARY KEY(`request_id`),
	CONSTRAINT `inference_free_reservations_external_event` UNIQUE(`external_event_id`)
);

--> statement-breakpoint
CREATE TABLE `inference_free_usage_buckets` (
	`user_id` varchar(64) NOT NULL,
	`window_start_at` timestamp(3) NOT NULL,
	`window_end_at` timestamp(3) NOT NULL,
	`limit_amount` bigint NOT NULL,
	`used_amount` bigint NOT NULL DEFAULT 0,
	`reserved_amount` bigint NOT NULL DEFAULT 0,
	`blocked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `inference_free_usage_buckets_user_id_window_start_at_pk` PRIMARY KEY(`user_id`,`window_start_at`)
);

--> statement-breakpoint
CREATE INDEX `inference_free_reservations_user_window` ON `inference_free_reservations` (`user_id`,`window_start_at`);
