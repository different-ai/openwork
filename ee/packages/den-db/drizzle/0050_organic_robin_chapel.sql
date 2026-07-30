CREATE TABLE `file_reference` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`byte_length` int unsigned NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`bytes` mediumblob NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `file_reference_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `file_reference_scope` ON `file_reference` (`organization_id`,`org_membership_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `file_reference_expires_at` ON `file_reference` (`expires_at`);