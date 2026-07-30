CREATE TABLE `ui_artifact_preference` (
	`member_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`enabled_artifact_ids` json NOT NULL,
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `ui_artifact_preference_member_id` PRIMARY KEY(`member_id`)
);
