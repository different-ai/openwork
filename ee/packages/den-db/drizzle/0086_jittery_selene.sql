ALTER TABLE `sso_connection` MODIFY COLUMN `status` varchar(32) NOT NULL DEFAULT 'disabled';--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `config_revision` varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `test_status` varchar(32) DEFAULT 'untested' NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `last_tested_revision` varchar(64);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `domain_verification_token` varchar(255);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `active_test_intent_id` varchar(64);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `active_test_user_id` varchar(64);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `active_test_provider_id` varchar(255);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `active_test_config_revision` varchar(64);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `active_test_expires_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `active_test_started_at` timestamp(3);