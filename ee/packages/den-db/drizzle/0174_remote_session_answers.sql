ALTER TABLE `remote_session_request` MODIFY COLUMN `action` enum('read','send','stop','answer') NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `session_pending` json;