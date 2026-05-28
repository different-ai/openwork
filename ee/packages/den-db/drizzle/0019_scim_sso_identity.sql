CREATE TABLE `external_identity` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`source` varchar(32) NOT NULL,
	`scim_provider_id` varchar(255),
	`sso_provider_id` varchar(255),
	`remote_id` varchar(191),
	`external_id` varchar(191),
	`user_name` varchar(191),
	`email` varchar(191),
	`display_name` varchar(191),
	`name_json` json,
	`emails_json` json,
	`attributes_json` json,
	`active` boolean NOT NULL DEFAULT true,
	`last_scim_sync_at` timestamp(3),
	`last_sso_login_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `external_identity_id` PRIMARY KEY(`id`),
	CONSTRAINT `external_identity_org_user` UNIQUE(`organization_id`,`user_id`),
	CONSTRAINT `external_identity_org_sso_remote` UNIQUE(`organization_id`,`sso_provider_id`,`remote_id`),
	CONSTRAINT `external_identity_org_scim_external` UNIQUE(`organization_id`,`scim_provider_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `scim_provider` (
	`id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`scim_token` text NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `scim_provider_id` PRIMARY KEY(`id`),
	CONSTRAINT `scim_provider_provider_id` UNIQUE(`provider_id`),
	CONSTRAINT `scim_provider_organization_id` UNIQUE(`organization_id`)
);
--> statement-breakpoint
CREATE TABLE `sso_connection` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`issuer` varchar(2048) NOT NULL,
	`domain` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'enabled',
	`sign_in_path` varchar(2048) NOT NULL,
	`last_tested_at` timestamp(3),
	`last_error` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_connection_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_connection_organization_id` UNIQUE(`organization_id`),
	CONSTRAINT `sso_connection_provider_id` UNIQUE(`provider_id`)
);
--> statement-breakpoint
CREATE TABLE `sso_provider` (
	`id` varchar(64) NOT NULL,
	`issuer` varchar(2048) NOT NULL,
	`domain` varchar(255) NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`domain_verified` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `sso_provider_id` PRIMARY KEY(`id`),
	CONSTRAINT `sso_provider_provider_id` UNIQUE(`provider_id`)
);
--> statement-breakpoint
CREATE INDEX `external_identity_org_email` ON `external_identity` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `external_identity_sso_provider` ON `external_identity` (`sso_provider_id`);--> statement-breakpoint
CREATE INDEX `external_identity_scim_provider` ON `external_identity` (`scim_provider_id`);--> statement-breakpoint
CREATE INDEX `sso_connection_domain` ON `sso_connection` (`domain`);--> statement-breakpoint
CREATE INDEX `sso_provider_domain` ON `sso_provider` (`domain`);--> statement-breakpoint
CREATE INDEX `sso_provider_organization_id` ON `sso_provider` (`organization_id`);--> statement-breakpoint
CREATE INDEX `sso_provider_user_id` ON `sso_provider` (`user_id`);
