ALTER TABLE `remote_session_command` ADD `target_computer_id` varchar(160);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `target_workspace_id` varchar(240);--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `inventory` json;--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `inventory_updated_at` timestamp(3);