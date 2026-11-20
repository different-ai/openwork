CREATE TABLE `skill_file_blob` (
	`organization_id` varchar(64) NOT NULL,
	`sha256` char(64) NOT NULL,
	`size` int NOT NULL,
	`bytes` mediumblob NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `skill_file_blob_pk` PRIMARY KEY(`organization_id`,`sha256`)
);
