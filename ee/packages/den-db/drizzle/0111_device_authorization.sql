CREATE TABLE `deviceCode` (
	`id` varchar(64) NOT NULL,
	`device_code` varchar(128) NOT NULL,
	`user_code` varchar(32) NOT NULL,
	`user_id` varchar(64),
	`organization_id` varchar(64),
	`expires_at` timestamp(3) NOT NULL,
	`status` varchar(32) NOT NULL,
	`last_polled_at` timestamp(3),
	`polling_interval` int,
	`client_id` varchar(255),
	`scope` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `deviceCode_id` PRIMARY KEY(`id`),
	CONSTRAINT `device_code_device_code` UNIQUE(`device_code`),
	CONSTRAINT `device_code_user_code` UNIQUE(`user_code`)
);
--> statement-breakpoint
CREATE INDEX `device_code_expires_at` ON `deviceCode` (`expires_at`);