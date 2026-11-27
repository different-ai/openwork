CREATE TABLE `cloud_coding_slack_notice` (
	`approval_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`channel_id` varchar(64) NOT NULL,
	`thread_ts` varchar(64) NOT NULL,
	`requester_slack_user_id` varchar(64) NOT NULL,
	`message_ts` varchar(64),
	`shown_status` enum('pending','approved','denied','pushed','expired','superseded'),
	`continued_at` timestamp(3),
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`lease_until` timestamp(3),
	`lease_owner` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `cloud_coding_slack_notice_approval_id` PRIMARY KEY(`approval_id`)
);
--> statement-breakpoint
ALTER TABLE `cloud_coding_task` ADD `surface` enum('workbot','slack','web') DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE `cloud_coding_task` ADD `conversation_id` varchar(240);--> statement-breakpoint
ALTER TABLE `cloud_coding_task` ADD `run_token_id` varchar(64);--> statement-breakpoint
ALTER TABLE `cloud_coding_task` ADD `runner_message_id` varchar(160);--> statement-breakpoint
CREATE INDEX `cloud_coding_slack_notice_queue` ON `cloud_coding_slack_notice` (`available_at`);