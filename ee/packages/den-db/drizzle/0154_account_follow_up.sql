CREATE TABLE `account_follow_up_action` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`kind` enum('reviewed','contacted','replied','meeting','note','closed','dismissed','reopened') NOT NULL,
	`actor_user_id` varchar(64) NOT NULL,
	`contact_user_id` varchar(64),
	`note` varchar(500),
	`follow_up_due_at` timestamp(3),
	`occurred_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `account_follow_up_action_id` PRIMARY KEY(`id`),
	CONSTRAINT `account_follow_up_action_request` UNIQUE(`organization_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `account_follow_up` (
	`organization_id` varchar(64) NOT NULL,
	`stage` enum('needs_review','ready','contacted','engaged','closed','dismissed') NOT NULL DEFAULT 'needs_review',
	`owner_user_id` varchar(64),
	`next_action` varchar(240),
	`next_follow_up_at` timestamp(3),
	`last_contacted_at` timestamp(3),
	`confirmed_opportunity` enum('expansion','commercial'),
	`updated_by_user_id` varchar(64) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `account_follow_up_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
CREATE INDEX `account_follow_up_action_org_time` ON `account_follow_up_action` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `account_follow_up_action_time` ON `account_follow_up_action` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `account_follow_up_due` ON `account_follow_up` (`stage`,`next_follow_up_at`);