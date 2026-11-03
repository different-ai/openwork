CREATE TABLE `feature_usage` (
	`member_id` varchar(64) NOT NULL,
	`feature_key` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`first_used_at` timestamp(3) NOT NULL DEFAULT (now()),
	`days_used` int NOT NULL DEFAULT 1,
	`last_used_at` timestamp(3) NOT NULL DEFAULT (now()),
	`last_used_day` date NOT NULL,
	CONSTRAINT `feature_usage_pk` PRIMARY KEY(`member_id`,`feature_key`)
);
--> statement-breakpoint
CREATE INDEX `feature_usage_org_feature` ON `feature_usage` (`organization_id`,`feature_key`,`last_used_at`);