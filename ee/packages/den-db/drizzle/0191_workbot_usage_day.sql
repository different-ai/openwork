CREATE TABLE `workbot_usage_day` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`day_start` timestamp(3) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`surface` varchar(32) NOT NULL,
	`model` varchar(255) NOT NULL DEFAULT '',
	`request_count` int NOT NULL DEFAULT 0,
	`unpriced_request_count` int NOT NULL DEFAULT 0,
	`input_tokens` bigint NOT NULL DEFAULT 0,
	`output_tokens` bigint NOT NULL DEFAULT 0,
	`cache_read_tokens` bigint NOT NULL DEFAULT 0,
	`cost_micro_usd` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `workbot_usage_day_id` PRIMARY KEY(`id`),
	CONSTRAINT `workbot_usage_day_dimension` UNIQUE(`organization_id`,`day_start`,`org_membership_id`,`surface`,`model`)
);
