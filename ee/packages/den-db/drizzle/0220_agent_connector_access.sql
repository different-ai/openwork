ALTER TABLE `personal_agent` ADD `legacy_connector_access` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `personal_agent` ADD `never_connection_ids` json;--> statement-breakpoint
ALTER TABLE `tool_approval` ADD `connector_access` boolean;--> statement-breakpoint
ALTER TABLE `tool_approval` ADD `owner_requested_at` timestamp(3);