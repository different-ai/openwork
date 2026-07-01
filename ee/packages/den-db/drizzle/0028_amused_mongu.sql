ALTER TABLE `external_mcp_connection` ADD `access_token` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `refresh_token` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `token_type` varchar(64);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `scope` varchar(1024);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `expires_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `pending_code_verifier` text;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `connected_at` timestamp(3);