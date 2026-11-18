CREATE TABLE `gateway_credential_sets` (
	`id` varchar(64) NOT NULL,
	`gateway_provider_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64),
	`name` varchar(255) NOT NULL,
	`credential_mode` enum('org','member') NOT NULL,
	`oauth_client_id` varchar(255),
	`oauth_client_secret` text,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_credential_sets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_keys` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`encrypted_key` text NOT NULL,
	`key_hash` varchar(64) NOT NULL,
	`key_prefix` varchar(32) NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`revoked_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_keys_org_member` UNIQUE(`organization_id`,`org_membership_id`),
	CONSTRAINT `gateway_keys_key_hash` UNIQUE(`key_hash`)
);
--> statement-breakpoint
CREATE TABLE `gateway_model_group_models` (
	`id` varchar(64) NOT NULL,
	`model_group_id` varchar(64) NOT NULL,
	`gateway_provider_model_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_model_group_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_model_group_models_group_model` UNIQUE(`model_group_id`,`gateway_provider_model_id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_model_groups` (
	`id` varchar(64) NOT NULL,
	`gateway_provider_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_model_groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
RENAME TABLE `inference_request_logs` TO `gateway_request_logs`;--> statement-breakpoint
RENAME TABLE `inference_rollup_lock` TO `gateway_rollup_lock`;--> statement-breakpoint
RENAME TABLE `inference_usage_rollups` TO `gateway_usage_rollups`;--> statement-breakpoint
RENAME TABLE `inference_provider_access` TO `gateway_provider_access`;--> statement-breakpoint
RENAME TABLE `inference_provider_credentials` TO `gateway_provider_credentials`;--> statement-breakpoint
RENAME TABLE `inference_provider_models` TO `gateway_provider_models`;--> statement-breakpoint
RENAME TABLE `inference_provider_oauth_states` TO `gateway_provider_oauth_states`;--> statement-breakpoint
RENAME TABLE `inference_providers` TO `gateway_providers`;--> statement-breakpoint
ALTER TABLE `gateway_request_logs` RENAME COLUMN `inference_provider_id` TO `gateway_provider_id`;--> statement-breakpoint
ALTER TABLE `gateway_request_logs` RENAME COLUMN `inference_provider_credential_id` TO `gateway_provider_credential_id`;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` RENAME COLUMN `inference_provider_id` TO `gateway_provider_id`;--> statement-breakpoint
ALTER TABLE `gateway_provider_access` RENAME COLUMN `inference_provider_id` TO `gateway_provider_id`;--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` RENAME COLUMN `inference_provider_id` TO `gateway_provider_id`;--> statement-breakpoint
ALTER TABLE `gateway_provider_models` RENAME COLUMN `inference_provider_id` TO `gateway_provider_id`;--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` RENAME COLUMN `inference_provider_id` TO `gateway_provider_id`;--> statement-breakpoint
ALTER TABLE `gateway_request_logs` DROP INDEX `inference_request_logs_openwork_request_id`;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` DROP INDEX `inference_usage_rollups_bucket_dimension`;--> statement-breakpoint
ALTER TABLE `gateway_provider_access` DROP INDEX `inference_provider_access_provider_org_membership`;--> statement-breakpoint
ALTER TABLE `gateway_provider_access` DROP INDEX `inference_provider_access_provider_team`;--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` DROP INDEX `inference_provider_credentials_provider_subject`;--> statement-breakpoint
ALTER TABLE `gateway_provider_models` DROP INDEX `inference_provider_models_provider_model`;--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` DROP INDEX `inference_provider_oauth_states_state`;--> statement-breakpoint
DROP INDEX `inference_request_logs_org_started` ON `gateway_request_logs`;--> statement-breakpoint
DROP INDEX `inference_request_logs_member_started` ON `gateway_request_logs`;--> statement-breakpoint
DROP INDEX `inference_request_logs_provider_started` ON `gateway_request_logs`;--> statement-breakpoint
DROP INDEX `inference_request_logs_started_at` ON `gateway_request_logs`;--> statement-breakpoint
DROP INDEX `inference_usage_rollups_org_granularity_bucket` ON `gateway_usage_rollups`;--> statement-breakpoint
DROP INDEX `inference_provider_access_org_membership_id` ON `gateway_provider_access`;--> statement-breakpoint
DROP INDEX `inference_provider_access_team_id` ON `gateway_provider_access`;--> statement-breakpoint
DROP INDEX `inference_provider_credentials_org_membership_id` ON `gateway_provider_credentials`;--> statement-breakpoint
DROP INDEX `inference_provider_credentials_organization_id` ON `gateway_provider_credentials`;--> statement-breakpoint
DROP INDEX `inference_provider_models_model_id` ON `gateway_provider_models`;--> statement-breakpoint
DROP INDEX `inference_provider_oauth_states_expires_at` ON `gateway_provider_oauth_states`;--> statement-breakpoint
DROP INDEX `inference_providers_organization_id` ON `gateway_providers`;--> statement-breakpoint
DROP INDEX `inference_providers_org_provider_id` ON `gateway_providers`;--> statement-breakpoint
ALTER TABLE `gateway_request_logs` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_provider_access` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_provider_models` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_providers` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_rollup_lock` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `gateway_request_logs` MODIFY COLUMN `inference_key_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_access` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_models` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_providers` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_rollup_lock` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD `gateway_key_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD `model_group_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD `credential_set_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD `access_grant_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `model_group_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `credential_set_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD `access_grant_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_provider_access` ADD `model_group_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_provider_access` ADD `credential_set_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_provider_access` ADD `audience_key` varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` ADD `credential_set_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` ADD `credential_set_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_providers` ADD `model_ids` json DEFAULT (JSON_ARRAY()) NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_request_logs` ADD CONSTRAINT `gateway_request_logs_openwork_request_id` UNIQUE(`openwork_request_id`);--> statement-breakpoint
ALTER TABLE `gateway_usage_rollups` ADD CONSTRAINT `gateway_usage_rollups_bucket_dimension` UNIQUE(`granularity`,`bucket_start`,`dimension_key`);--> statement-breakpoint
ALTER TABLE `gateway_provider_access` ADD CONSTRAINT `gateway_provider_access_audience_group_set` UNIQUE(`gateway_provider_id`,`audience_key`,`model_group_id`,`credential_set_id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` ADD CONSTRAINT `gateway_provider_credentials_set_subject` UNIQUE(`credential_set_id`,`subject`);--> statement-breakpoint
ALTER TABLE `gateway_provider_models` ADD CONSTRAINT `gateway_provider_models_provider_model` UNIQUE(`gateway_provider_id`,`model_id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` ADD CONSTRAINT `gateway_provider_oauth_states_state` UNIQUE(`state`);--> statement-breakpoint
CREATE INDEX `gateway_credential_sets_provider_id` ON `gateway_credential_sets` (`gateway_provider_id`);--> statement-breakpoint
CREATE INDEX `gateway_keys_org_membership_id` ON `gateway_keys` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `gateway_keys_status` ON `gateway_keys` (`status`);--> statement-breakpoint
CREATE INDEX `gateway_model_group_models_model_id` ON `gateway_model_group_models` (`gateway_provider_model_id`);--> statement-breakpoint
CREATE INDEX `gateway_model_groups_provider_id` ON `gateway_model_groups` (`gateway_provider_id`);--> statement-breakpoint
ALTER TABLE `gateway_provider_access` ADD CONSTRAINT `gateway_provider_access_audience` CHECK (
      (`gateway_provider_access`.`org_membership_id` IS NULL OR `gateway_provider_access`.`team_id` IS NULL)
      AND `gateway_provider_access`.`audience_key` = CASE
        WHEN `gateway_provider_access`.`org_membership_id` IS NOT NULL THEN CONCAT('member:', `gateway_provider_access`.`org_membership_id`)
        WHEN `gateway_provider_access`.`team_id` IS NOT NULL THEN CONCAT('team:', `gateway_provider_access`.`team_id`)
        ELSE 'organization' END
    );--> statement-breakpoint
CREATE INDEX `gateway_request_logs_org_started` ON `gateway_request_logs` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `gateway_request_logs_member_started` ON `gateway_request_logs` (`org_membership_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `gateway_request_logs_provider_started` ON `gateway_request_logs` (`gateway_provider_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `gateway_request_logs_started_at` ON `gateway_request_logs` (`started_at`);--> statement-breakpoint
CREATE INDEX `gateway_usage_rollups_org_granularity_bucket` ON `gateway_usage_rollups` (`organization_id`,`granularity`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `gateway_provider_access_org_membership_id` ON `gateway_provider_access` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_access_team_id` ON `gateway_provider_access` (`team_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_access_credential_set_id` ON `gateway_provider_access` (`credential_set_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_access_model_group_id` ON `gateway_provider_access` (`model_group_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_credentials_provider_id` ON `gateway_provider_credentials` (`gateway_provider_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_credentials_org_membership_id` ON `gateway_provider_credentials` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_credentials_organization_id` ON `gateway_provider_credentials` (`organization_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_models_model_id` ON `gateway_provider_models` (`model_id`);--> statement-breakpoint
CREATE INDEX `gateway_provider_oauth_states_expires_at` ON `gateway_provider_oauth_states` (`expires_at`);--> statement-breakpoint
CREATE INDEX `gateway_provider_oauth_states_set_member` ON `gateway_provider_oauth_states` (`credential_set_id`,`org_membership_id`);--> statement-breakpoint
CREATE INDEX `gateway_providers_organization_id` ON `gateway_providers` (`organization_id`);--> statement-breakpoint
CREATE INDEX `gateway_providers_org_provider_id` ON `gateway_providers` (`organization_id`,`provider_id`);