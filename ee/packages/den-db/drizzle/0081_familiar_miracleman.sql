CREATE TABLE `remote_session_command` (
	`id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`owner_member_id` varchar(64) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`status` enum('pending','claimed','delivered','failed','expired') NOT NULL,
	`title` varchar(120) NOT NULL,
	`prompt` text,
	`model_provider_id` varchar(160),
	`model_model_id` varchar(160),
	`model_variant` varchar(60),
	`idempotency_key` varchar(160),
	`expires_at` timestamp(3) NOT NULL,
	`claimed_by_runner_id` varchar(160),
	`claimed_at` timestamp(3),
	`session_id` varchar(240),
	`workspace_id` varchar(240),
	`result_summary` varchar(4096),
	`error_code` varchar(60),
	`error_message` varchar(2000),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `remote_session_command_id` PRIMARY KEY(`id`),
	CONSTRAINT `remote_session_command_idempotency_key` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `remote_session_command_owner_status` ON `remote_session_command` (`org_id`,`owner_member_id`,`status`);--> statement-breakpoint
CREATE INDEX `remote_session_command_status_expires` ON `remote_session_command` (`status`,`expires_at`);