CREATE TABLE `feature_intro_state` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`intro_key` varchar(120) NOT NULL,
	`intro_version` int NOT NULL,
	`first_seen_at` timestamp(3),
	`last_seen_at` timestamp(3),
	`dismissed_at` timestamp(3),
	`cta_clicked_at` timestamp(3),
	`completed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `feature_intro_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `feature_intro_state_member_key` UNIQUE(`organization_id`,`member_id`,`intro_key`)
);
--> statement-breakpoint
CREATE INDEX `feature_intro_state_member` ON `feature_intro_state` (`organization_id`,`member_id`);