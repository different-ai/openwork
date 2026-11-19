ALTER TABLE `gateway_provider_credentials` MODIFY COLUMN `kind` enum('api_key','api_key_map','aws_keys','gcp_service_account','oauth_google','oauth_azure','aws_sso') NOT NULL;--> statement-breakpoint
ALTER TABLE `gateway_credential_sets` ADD `oauth_tenant_id` varchar(64);--> statement-breakpoint
ALTER TABLE `gateway_credential_sets` ADD `aws_sso` json;