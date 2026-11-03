-- One idempotent statement per table, indexes inline: PlanetScale applies DDL
-- outside the transaction (see 0145).
CREATE TABLE IF NOT EXISTS `sandbox_organization` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`join_token` varchar(64) NOT NULL,
	`connector_base_url` varchar(2048),
	`member_limit` int NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`closed_at` timestamp(3),
	`created_by_user_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `sandbox_organization_id` PRIMARY KEY(`id`),
	CONSTRAINT `sandbox_organization_organization` UNIQUE(`organization_id`),
	CONSTRAINT `sandbox_organization_join_token` UNIQUE(`join_token`)
);
