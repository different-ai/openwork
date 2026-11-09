CREATE TABLE `den_instance` (
	`singleton` varchar(16) NOT NULL,
	`instance_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `den_instance_singleton` PRIMARY KEY(`singleton`)
);
--> statement-breakpoint
CREATE TABLE `config_blob_alias` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`area` varchar(64) NOT NULL,
	`source_instance_id` varchar(100) NOT NULL,
	`source_id` varchar(100) NOT NULL,
	`local_id` varchar(100) NOT NULL,
	`created_by_change_request_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `config_blob_alias_id` PRIMARY KEY(`id`),
	CONSTRAINT `config_blob_alias_source` UNIQUE(`organization_id`,`area`,`source_instance_id`,`source_id`)
);
--> statement-breakpoint
CREATE TABLE `config_blob_export` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`base_hash` varchar(80) NOT NULL,
	`areas` json NOT NULL,
	`blob` mediumtext NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `config_blob_export_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `config_change_request` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'uploaded',
	`title` varchar(200),
	`mode` varchar(16) NOT NULL DEFAULT 'merge',
	`source_kind` varchar(16) NOT NULL,
	`created_by_member_id` varchar(64),
	`api_key_id` varchar(64),
	`api_key_name` varchar(255),
	`blob` mediumtext NOT NULL,
	`source_instance_id` varchar(100),
	`source_org_id` varchar(100),
	`source_org_slug` varchar(255),
	`source_org_name` varchar(255),
	`source_deployment` varchar(16),
	`areas` json NOT NULL,
	`base_hash` varchar(80),
	`plan` mediumtext,
	`plan_hash` varchar(80),
	`decisions` json,
	`secret_inputs` mediumtext,
	`approvals` json NOT NULL,
	`approved_plan_hash` varchar(80),
	`apply_requested_by` json,
	`auto_apply` boolean NOT NULL DEFAULT false,
	`before_snapshot` mediumtext,
	`report` json,
	`errors` json NOT NULL,
	`lease_owner` varchar(64),
	`lease_until` timestamp(3),
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`attempts` int NOT NULL DEFAULT 0,
	`reverts_change_request_id` varchar(64),
	`reverted_by_change_request_id` varchar(64),
	`applied_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `config_change_request_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `config_blob_export_org_base` ON `config_blob_export` (`organization_id`,`base_hash`);--> statement-breakpoint
CREATE INDEX `config_change_request_org_status` ON `config_change_request` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `config_change_request_queue` ON `config_change_request` (`status`,`available_at`);