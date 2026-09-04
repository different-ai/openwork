ALTER TABLE `external_mcp_connection` ADD `external_key` varchar(128);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD CONSTRAINT `external_mcp_connection_org_external_key` UNIQUE(`organization_id`,`external_key`);
