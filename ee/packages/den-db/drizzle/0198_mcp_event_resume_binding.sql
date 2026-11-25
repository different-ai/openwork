ALTER TABLE `mcp_event_turn` ADD `resume_grant_id` varchar(64);--> statement-breakpoint
CREATE INDEX `mcp_event_turn_resume_grant` ON `mcp_event_turn` (`resume_grant_id`);