CREATE TABLE `computer_disconnection` (
	`id` varchar(160) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`owner_member_id` varchar(64) NOT NULL,
	`disconnected_at` timestamp(3) NOT NULL,
	`disconnected_by_member_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `computer_disconnection_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `install_id` varchar(160);--> statement-breakpoint
ALTER TABLE `automation_runner` ADD `auth_session_id` varchar(64);--> statement-breakpoint
CREATE INDEX `computer_disconnection_owner` ON `computer_disconnection` (`organization_id`,`owner_member_id`);