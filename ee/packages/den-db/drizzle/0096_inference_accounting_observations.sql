CREATE TABLE `inference_rollup_lock` (
	`id` int NOT NULL,
	CONSTRAINT `inference_rollup_lock_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `input_tokens_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `output_tokens_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `total_tokens_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `cache_read_tokens_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `cache_write_tokens_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `reasoning_tokens_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `cost_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `latency_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `ttfb_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `request_bytes_count` bigint;--> statement-breakpoint
ALTER TABLE `inference_usage_rollups` ADD `response_bytes_count` bigint;