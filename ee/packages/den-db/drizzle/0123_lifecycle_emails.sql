CREATE TABLE `lifecycle_email` (
	`kind` varchar(64) NOT NULL,
	`subject_key` varchar(255) NOT NULL,
	`recipient` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'sending',
	`error` varchar(255),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`sent_at` timestamp(3),
	CONSTRAINT `lifecycle_email_kind_subject` PRIMARY KEY(`kind`,`subject_key`)
);
--> statement-breakpoint
ALTER TABLE `workspace_bootstrap` ADD `owner_email` varchar(255);--> statement-breakpoint
ALTER TABLE `workspace_bootstrap` ADD `teammate_emails` json;--> statement-breakpoint
CREATE INDEX `lifecycle_email_recipient` ON `lifecycle_email` (`recipient`);