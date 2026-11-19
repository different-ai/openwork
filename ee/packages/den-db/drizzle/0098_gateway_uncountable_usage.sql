ALTER TABLE `gateway_usage_rollups` ADD `uncountable_ok_count` bigint;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `uncountable_upstream_error_count` bigint;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `uncountable_upstream_unreachable_count` bigint;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `uncountable_client_aborted_count` bigint;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `uncountable_rejected_count` bigint;