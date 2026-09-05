ALTER TABLE `desktop_policy` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `llm_provider` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `marketplace` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `team` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `desktop_policy` ADD CONSTRAINT `desktop_policy_org_external_key` UNIQUE(`organization_id`,`external_key`);--> statement-breakpoint
ALTER TABLE `llm_provider` ADD CONSTRAINT `llm_provider_org_external_key` UNIQUE(`organization_id`,`external_key`);--> statement-breakpoint
ALTER TABLE `marketplace` ADD CONSTRAINT `marketplace_org_external_key` UNIQUE(`organization_id`,`external_key`);--> statement-breakpoint
ALTER TABLE `team` ADD CONSTRAINT `team_org_external_key` UNIQUE(`organization_id`,`external_key`);