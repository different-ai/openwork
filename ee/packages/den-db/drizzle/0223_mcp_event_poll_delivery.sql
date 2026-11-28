ALTER TABLE `mcp_event_subscription` ADD `delivery` varchar(16) DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_event_subscription` ADD `next_poll_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `mcp_event_subscription` ADD `poll_failures` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `mcp_event_subscription_poll` ON `mcp_event_subscription` (`delivery`,`next_poll_at`);