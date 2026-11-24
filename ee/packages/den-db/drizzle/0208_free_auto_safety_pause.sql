CREATE TABLE `free_auto_safety_pause` (
	`identifier` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`actor_id` varchar(64) NOT NULL,
	`reason` varchar(32) NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `free_auto_safety_pause_identifier` PRIMARY KEY(`identifier`)
);
