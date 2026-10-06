CREATE TABLE `license_snapshot` (
	`fingerprint` varchar(64) NOT NULL,
	`snapshot` json NOT NULL,
	CONSTRAINT `license_snapshot_fingerprint` PRIMARY KEY(`fingerprint`)
);
--> statement-breakpoint
ALTER TABLE `organization` ADD `modules` json;