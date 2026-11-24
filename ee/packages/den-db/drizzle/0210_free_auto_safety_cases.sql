CREATE TABLE `free_auto_safety_case` (
	`case_key` varchar(64) NOT NULL,
	`case_id` varchar(128) NOT NULL,
	`identifier` varchar(64),
	`notice` enum('warning','deactivation','local_review') NOT NULL,
	`reason` varchar(100),
	`state` enum('review','blocked','closed') NOT NULL,
	`issued_at` timestamp(3) NOT NULL,
	`reviewer_id` varchar(64),
	`decision` varchar(40),
	`review_history` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `free_auto_safety_case_case_key` PRIMARY KEY(`case_key`)
);
--> statement-breakpoint
CREATE TABLE `free_auto_safety_member` (
	`identifier` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	CONSTRAINT `free_auto_safety_member_identifier` PRIMARY KEY(`identifier`)
);
--> statement-breakpoint
CREATE INDEX `free_auto_safety_case_enforce` ON `free_auto_safety_case` (`identifier`,`state`);--> statement-breakpoint
CREATE INDEX `free_auto_safety_case_queue` ON `free_auto_safety_case` (`state`,`issued_at`);