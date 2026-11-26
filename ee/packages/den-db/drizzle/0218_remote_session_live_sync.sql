CREATE TABLE `remote_session_tail` (
	`org_id` varchar(64) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`thread_key` varchar(280) NOT NULL,
	`owner_member_id` varchar(64),
	`command_id` varchar(64),
	`runner_id` varchar(160),
	`payload` mediumtext NOT NULL,
	`byte_size` int NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `remote_session_tail_pk` PRIMARY KEY(`org_id`,`created_by_user_id`,`thread_key`)
);
--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `parent_session_id` varchar(240);--> statement-breakpoint
ALTER TABLE `remote_session_command` ADD `parent_workspace_id` varchar(240);--> statement-breakpoint
CREATE INDEX `remote_session_tail_expires` ON `remote_session_tail` (`expires_at`);--> statement-breakpoint
CREATE INDEX `remote_session_tail_command` ON `remote_session_tail` (`command_id`);--> statement-breakpoint
CREATE INDEX `remote_session_tail_runner` ON `remote_session_tail` (`org_id`,`owner_member_id`,`runner_id`);--> statement-breakpoint
CREATE INDEX `remote_session_tail_member` ON `remote_session_tail` (`org_id`,`owner_member_id`);--> statement-breakpoint
CREATE INDEX `remote_session_command_parent` ON `remote_session_command` (`org_id`,`created_by_user_id`,`parent_session_id`);