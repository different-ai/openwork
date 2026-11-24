-- One idempotent statement, indexes inline: PlanetScale applies DDL outside the transaction (see 0145).
CREATE TABLE IF NOT EXISTS `agent_check` (
	`organization_id` varchar(64) NOT NULL,
	`day` varchar(10) NOT NULL,
	`responsibility` varchar(32) NOT NULL,
	`checks` int NOT NULL DEFAULT 0,
	`quiet` int NOT NULL DEFAULT 0,
	`sent` int NOT NULL DEFAULT 0,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_check_pk` PRIMARY KEY(`organization_id`,`day`,`responsibility`)
);
