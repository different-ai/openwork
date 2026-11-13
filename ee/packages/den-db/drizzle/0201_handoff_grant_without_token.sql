ALTER TABLE `desktop_handoff_grant` MODIFY COLUMN `session_token` text;--> statement-breakpoint
ALTER TABLE `desktop_handoff_grant` ADD `session_id` varchar(64);--> statement-breakpoint
ALTER TABLE `desktop_handoff_grant` ADD `organization_id` varchar(64);