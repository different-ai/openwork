ALTER TABLE `connected_account` ADD `credential_health` json;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `credential_health` json;--> statement-breakpoint
ALTER TABLE `external_mcp_connection` ADD `oauth_issuer_review_required_at` timestamp(3);