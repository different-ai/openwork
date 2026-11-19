CREATE TABLE `managed_installer_change` (
	`id` varchar(36) NOT NULL,
	`provider` enum('aws','gcp') NOT NULL,
	`action` enum('source_saved','approval_saved','pinned','reset') NOT NULL,
	`actor` varchar(128) NOT NULL,
	`version` varchar(80),
	`manifest_sha256` varchar(64),
	`qualification` json,
	`before` json NOT NULL,
	`after` json NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `managed_installer_change_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `managed_installer_config` (
	`provider` enum('aws','gcp') NOT NULL,
	`source_base_url` varchar(2048),
	`approval_mode` enum('platform_admin','independent_admin') NOT NULL DEFAULT 'independent_admin',
	`release` json,
	`revision` varchar(36) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `managed_installer_config_provider` PRIMARY KEY(`provider`)
);
--> statement-breakpoint
CREATE TABLE `managed_installer_validation` (
	`id` varchar(36) NOT NULL,
	`provider` enum('aws','gcp') NOT NULL,
	`revision` varchar(64) NOT NULL,
	`validation` json NOT NULL,
	`manifest_url` varchar(2048) NOT NULL,
	`template_sha256` varchar(64) NOT NULL,
	`actor` varchar(128) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `managed_installer_validation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `managed_installer_change_created` ON `managed_installer_change` (`created_at`);--> statement-breakpoint
CREATE INDEX `managed_installer_validation_expiry` ON `managed_installer_validation` (`expires_at`);