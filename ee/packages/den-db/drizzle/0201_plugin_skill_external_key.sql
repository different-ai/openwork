ALTER TABLE `config_object` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `plugin` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `config_object` ADD CONSTRAINT `config_object_org_external_key` UNIQUE(`organization_id`,`external_key`);--> statement-breakpoint
ALTER TABLE `plugin` ADD CONSTRAINT `plugin_org_external_key` UNIQUE(`organization_id`,`external_key`);