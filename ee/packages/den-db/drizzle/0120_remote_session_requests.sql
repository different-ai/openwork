CREATE TABLE `remote_session_request` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`owner_member_id` varchar(64) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`command_id` varchar(64) NOT NULL,
	`target_runner_id` varchar(160) NOT NULL,
	`workspace_id` varchar(240) NOT NULL,
	`session_id` varchar(240) NOT NULL,
	`session_engine` enum('v1','v2'),
	`action` enum('read','send','stop') NOT NULL,
	`input` json NOT NULL,
	`status` enum('pending','claimed','done','failed','expired') NOT NULL,
	`result` json,
	`error_code` varchar(60),
	`error_message` varchar(2000),
	`expires_at` timestamp(3) NOT NULL,
	`claimed_at` timestamp(3),
	`completed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `remote_session_request_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `remote_session_request_runner_status` ON `remote_session_request` (`org_id`,`owner_member_id`,`target_runner_id`,`status`);--> statement-breakpoint
CREATE INDEX `remote_session_request_status_expires` ON `remote_session_request` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `remote_session_command_creator_session` ON `remote_session_command` (`org_id`,`created_by_user_id`,`session_id`);