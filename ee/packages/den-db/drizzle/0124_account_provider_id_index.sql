CREATE INDEX `account_provider_id_account_id` ON `account` (`provider_id`(191),`account_id`(191));--> statement-breakpoint
DROP INDEX `account_account_id_provider_id` ON `account`;
