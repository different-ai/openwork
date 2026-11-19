ALTER TABLE `gateway_usage_limit_policy` ADD `inference_provider_id` varchar(64);--> statement-breakpoint
CREATE INDEX `gateway_usage_policy_provider` ON `gateway_usage_limit_policy` (`organization_id`,`inference_provider_id`);--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket` ADD `provider_scope` varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket` ADD CONSTRAINT `gateway_usage_bucket_scope_window` UNIQUE(`organization_id`,`member_id`,`provider_scope`,`timeframe`,`start_at`);--> statement-breakpoint
ALTER TABLE `gateway_usage_bucket` DROP INDEX `gateway_usage_bucket_window`;--> statement-breakpoint
ALTER TABLE `gateway_usage_reset_request` ADD `provider_scope` varchar(64) DEFAULT '' NOT NULL;
