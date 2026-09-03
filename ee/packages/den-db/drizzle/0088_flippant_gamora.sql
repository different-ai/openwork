CREATE TABLE `inference_request_logs` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`inference_key_id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64),
	`inference_provider_credential_id` varchar(64),
	`route` enum('openwork_openrouter','org_provider') NOT NULL,
	`protocol` enum('openai_chat','openai_responses','anthropic_messages','google_generate_content','bedrock_converse','passthrough') NOT NULL,
	`upstream_provider_id` varchar(64) NOT NULL,
	`upstream_host` varchar(255) NOT NULL,
	`upstream_path` varchar(512) NOT NULL,
	`method` varchar(8) NOT NULL,
	`requested_model` varchar(255),
	`upstream_model` varchar(255),
	`stream` boolean NOT NULL,
	`status` smallint,
	`outcome` enum('ok','upstream_error','upstream_unreachable','client_aborted','rejected') NOT NULL,
	`error_code` varchar(64),
	`input_tokens` int,
	`output_tokens` int,
	`total_tokens` int,
	`cache_read_tokens` int,
	`cache_write_tokens` int,
	`reasoning_tokens` int,
	`usage_source` enum('stream','json','missing') NOT NULL,
	`cost_micro_usd` bigint,
	`upstream_request_id` varchar(255),
	`openwork_request_id` varchar(32) NOT NULL,
	`started_at` timestamp(3) NOT NULL,
	`first_byte_at` timestamp(3),
	`completed_at` timestamp(3),
	`request_bytes` bigint,
	`response_bytes` bigint,
	`metadata` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_request_logs_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_request_logs_openwork_request_id` UNIQUE(`openwork_request_id`)
);
--> statement-breakpoint
CREATE TABLE `inference_usage_rollups` (
	`id` varchar(64) NOT NULL,
	`granularity` enum('hour','day') NOT NULL,
	`bucket_start` timestamp(3) NOT NULL,
	`dimension_key` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64),
	`route` enum('openwork_openrouter','org_provider') NOT NULL,
	`protocol` enum('openai_chat','openai_responses','anthropic_messages','google_generate_content','bedrock_converse','passthrough') NOT NULL,
	`upstream_provider_id` varchar(64) NOT NULL,
	`upstream_model` varchar(255),
	`request_count` int NOT NULL DEFAULT 0,
	`ok_count` int NOT NULL DEFAULT 0,
	`error_count` int NOT NULL DEFAULT 0,
	`aborted_count` int NOT NULL DEFAULT 0,
	`stream_count` int NOT NULL DEFAULT 0,
	`usage_missing_count` int NOT NULL DEFAULT 0,
	`input_tokens` bigint NOT NULL DEFAULT 0,
	`output_tokens` bigint NOT NULL DEFAULT 0,
	`total_tokens` bigint NOT NULL DEFAULT 0,
	`cache_read_tokens` bigint NOT NULL DEFAULT 0,
	`cache_write_tokens` bigint NOT NULL DEFAULT 0,
	`reasoning_tokens` bigint NOT NULL DEFAULT 0,
	`cost_micro_usd` bigint NOT NULL DEFAULT 0,
	`latency_ms_sum` bigint NOT NULL DEFAULT 0,
	`ttfb_ms_sum` bigint NOT NULL DEFAULT 0,
	`request_bytes` bigint NOT NULL DEFAULT 0,
	`response_bytes` bigint NOT NULL DEFAULT 0,
	`source_row_count` int NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_usage_rollups_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_usage_rollups_bucket_dimension` UNIQUE(`granularity`,`bucket_start`,`dimension_key`)
);
--> statement-breakpoint
CREATE TABLE `inference_provider_access` (
	`id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_provider_access_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_provider_access_provider_org_membership` UNIQUE(`inference_provider_id`,`org_membership_id`),
	CONSTRAINT `inference_provider_access_provider_team` UNIQUE(`inference_provider_id`,`team_id`)
);
--> statement-breakpoint
CREATE TABLE `inference_provider_credentials` (
	`id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`subject` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`kind` enum('api_key','api_key_map','aws_keys','gcp_service_account','oauth_google','oauth_azure') NOT NULL,
	`secret` mediumtext NOT NULL,
	`expires_at` timestamp(3),
	`refreshing_until` timestamp(3),
	`last_refreshed_at` timestamp(3),
	`scopes` varchar(1024),
	`last_error` text,
	`status` enum('active','revoked','refresh_failed') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_provider_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_provider_credentials_provider_subject` UNIQUE(`inference_provider_id`,`subject`)
);
--> statement-breakpoint
CREATE TABLE `inference_provider_models` (
	`id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`model_config` json NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_provider_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_provider_models_provider_model` UNIQUE(`inference_provider_id`,`model_id`)
);
--> statement-breakpoint
CREATE TABLE `inference_provider_oauth_states` (
	`id` varchar(64) NOT NULL,
	`inference_provider_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`state` varchar(255) NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_to` varchar(2048),
	`expires_at` timestamp(3) NOT NULL,
	`used_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `inference_provider_oauth_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `inference_provider_oauth_states_state` UNIQUE(`state`)
);
--> statement-breakpoint
CREATE TABLE `inference_providers` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`provider_config` json NOT NULL,
	`settings` json NOT NULL,
	`credential_mode` enum('org','member') NOT NULL DEFAULT 'org',
	`oauth_client_id` varchar(255),
	`oauth_client_secret` text,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `inference_providers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `inference_request_logs_org_started` ON `inference_request_logs` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `inference_request_logs_member_started` ON `inference_request_logs` (`org_membership_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `inference_request_logs_provider_started` ON `inference_request_logs` (`inference_provider_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `inference_request_logs_started_at` ON `inference_request_logs` (`started_at`);--> statement-breakpoint
CREATE INDEX `inference_usage_rollups_org_granularity_bucket` ON `inference_usage_rollups` (`organization_id`,`granularity`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `inference_provider_access_org_membership_id` ON `inference_provider_access` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `inference_provider_access_team_id` ON `inference_provider_access` (`team_id`);--> statement-breakpoint
CREATE INDEX `inference_provider_credentials_org_membership_id` ON `inference_provider_credentials` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `inference_provider_credentials_organization_id` ON `inference_provider_credentials` (`organization_id`);--> statement-breakpoint
CREATE INDEX `inference_provider_models_model_id` ON `inference_provider_models` (`model_id`);--> statement-breakpoint
CREATE INDEX `inference_provider_oauth_states_expires_at` ON `inference_provider_oauth_states` (`expires_at`);--> statement-breakpoint
CREATE INDEX `inference_providers_organization_id` ON `inference_providers` (`organization_id`);--> statement-breakpoint
CREATE INDEX `inference_providers_org_provider_id` ON `inference_providers` (`organization_id`,`provider_id`);