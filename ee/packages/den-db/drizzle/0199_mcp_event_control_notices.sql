ALTER TABLE `mcp_event_subscription` ADD `cursor` text;--> statement-breakpoint
ALTER TABLE `mcp_event_subscription` ADD `incomplete` boolean DEFAULT false NOT NULL;