CREATE TABLE `agent_member_check` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`checked_at` timestamp(3) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`outcome` varchar(8) NOT NULL,
	`reason` varchar(32) NOT NULL,
	`summary` varchar(400) NOT NULL,
	`responsibilities` json,
	`message` json,
	CONSTRAINT `agent_member_check_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `agent_instance` ADD `preferences` mediumtext;--> statement-breakpoint
CREATE INDEX `agent_member_check_member` ON `agent_member_check` (`member_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `agent_member_check_time` ON `agent_member_check` (`checked_at`);