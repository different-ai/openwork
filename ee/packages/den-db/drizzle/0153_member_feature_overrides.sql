CREATE TABLE `member_feature` (
	`member_id` varchar(64) NOT NULL,
	`feature_key` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`set_by_user_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `member_feature_pk` PRIMARY KEY(`member_id`,`feature_key`)
);
