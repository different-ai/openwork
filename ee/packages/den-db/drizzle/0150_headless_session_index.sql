CREATE TABLE `headless_session_index` (
	`session_id` varchar(128) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`member_id` varchar(64),
	`kind` enum('workbot','slack','automation') NOT NULL,
	`title` varchar(200) NOT NULL DEFAULT '',
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	`hot_bytes` bigint NOT NULL DEFAULT 0,
	`segment_count` int NOT NULL DEFAULT 0,
	`total_bytes` bigint NOT NULL DEFAULT 0,
	`active_turn_since` timestamp(3),
	`deleted_at` timestamp(3),
	`version` bigint NOT NULL,
	`retention_class` varchar(64),
	`legal_hold` boolean NOT NULL DEFAULT false,
	`last_reported_at` timestamp(3) NOT NULL,
	CONSTRAINT `headless_session_index_session_id` PRIMARY KEY(`session_id`)
);
--> statement-breakpoint
CREATE INDEX `headless_session_index_org` ON `headless_session_index` (`org_id`);--> statement-breakpoint
CREATE INDEX `headless_session_index_org_member` ON `headless_session_index` (`org_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `headless_session_index_org_updated` ON `headless_session_index` (`org_id`,`updated_at`);