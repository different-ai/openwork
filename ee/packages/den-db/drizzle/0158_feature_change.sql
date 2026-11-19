-- One idempotent statement per table, indexes inline: PlanetScale applies DDL
-- outside the transaction (see 0145).
CREATE TABLE IF NOT EXISTS `feature_change` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`feature_key` varchar(64) NOT NULL,
	`scope` enum('everyone','organization','member') NOT NULL,
	`organization_id` varchar(64),
	`member_id` varchar(64),
	`action` enum('on','off','reset','killed','restored') NOT NULL,
	`changed_by_user_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `feature_change_id` PRIMARY KEY(`id`),
	INDEX `feature_change_org_feature_time` (`organization_id`,`feature_key`,`created_at`),
	INDEX `feature_change_scope_feature_time` (`scope`,`feature_key`,`created_at`)
);
