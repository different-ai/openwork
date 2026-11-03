CREATE TABLE `db_replica_heartbeat` (
	`id` varchar(64) NOT NULL,
	`beat_at` timestamp(3) NOT NULL,
	CONSTRAINT `db_replica_heartbeat_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `db_replica_heartbeat_beat_at` ON `db_replica_heartbeat` (`beat_at`);