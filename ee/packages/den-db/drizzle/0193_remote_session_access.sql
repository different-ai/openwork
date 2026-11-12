ALTER TABLE `remote_session_command` ADD `kind` varchar(32) DEFAULT 'create' NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `target_session_id` varchar(240);--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `session_access` varchar(16);--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `sessions` json;--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `sessions_updated_at` timestamp(3);