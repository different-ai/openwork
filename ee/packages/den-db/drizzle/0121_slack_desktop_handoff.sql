CREATE TABLE `slack_assistant_desktop_handoff` (
	`command_id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`channel_id` varchar(64) NOT NULL,
	`thread_ts` varchar(64) NOT NULL,
	`recipient_user_id` varchar(64) NOT NULL,
	`posted_outcome` enum('finished','failed','expired','undeliverable','abandoned'),
	`waiting_posted` boolean NOT NULL DEFAULT false,
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`lease_until` timestamp(3),
	`lease_owner` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `slack_assistant_desktop_handoff_command_id` PRIMARY KEY(`command_id`)
);
--> statement-breakpoint
CREATE TABLE `slack_assistant_run_token` (
	`token_id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `slack_assistant_run_token_token_id` PRIMARY KEY(`token_id`)
);
--> statement-breakpoint
CREATE INDEX `slack_assistant_desktop_handoff_queue` ON `slack_assistant_desktop_handoff` (`posted_outcome`,`available_at`);--> statement-breakpoint
CREATE INDEX `slack_assistant_run_token_expiry` ON `slack_assistant_run_token` (`expires_at`);