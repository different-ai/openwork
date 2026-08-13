CREATE TABLE `temp_file` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_user_id` varchar(64) NOT NULL,
	`upload_token_hash` varchar(128) NOT NULL,
	`download_token_hash` varchar(128) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`content_type` varchar(255) NOT NULL DEFAULT 'application/octet-stream',
	`max_bytes` bigint NOT NULL,
	`size_bytes` bigint,
	`storage_tier` enum('volume','s3') NOT NULL,
	`storage_key` varchar(512) NOT NULL,
	`status` enum('pending','uploaded') NOT NULL DEFAULT 'pending',
	`expected_sha256` varchar(64),
	`content_sha256` varchar(64),
	`uploaded_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `temp_file_id` PRIMARY KEY(`id`),
	CONSTRAINT `temp_file_upload_token_hash` UNIQUE(`upload_token_hash`),
	CONSTRAINT `temp_file_download_token_hash` UNIQUE(`download_token_hash`)
);
--> statement-breakpoint
CREATE INDEX `temp_file_organization_id` ON `temp_file` (`organization_id`);--> statement-breakpoint
CREATE INDEX `temp_file_expires_at` ON `temp_file` (`expires_at`);