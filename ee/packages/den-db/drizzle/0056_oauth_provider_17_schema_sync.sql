CREATE TABLE `oauthClientAssertion` (
	`id` varchar(64) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	CONSTRAINT `oauthClientAssertion_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauthClientResource` (
	`id` varchar(512) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`resource_id` varchar(255) NOT NULL,
	`metadata` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `oauthClientResource_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauthResource` (
	`id` varchar(64) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`access_token_ttl` int,
	`refresh_token_ttl` int,
	`signing_algorithm` varchar(64),
	`signing_key_id` varchar(255),
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` boolean,
	`disabled` boolean,
	`policy_version` int,
	`metadata` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `oauthResource_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_resource_identifier` UNIQUE(`identifier`)
);
--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `authorization_code_id` varchar(64);--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `revoked` timestamp(3);--> statement-breakpoint
ALTER TABLE `oauthAccessToken` ADD `confirmation` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `backchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `backchannel_logout_session_required` boolean;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `jwks` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `jwks_uri` text;--> statement-breakpoint
ALTER TABLE `oauthClient` ADD `dpop_bound_access_tokens` boolean;--> statement-breakpoint
ALTER TABLE `oauthConsent` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauthConsent` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `authorization_code_id` varchar(64);--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `rotated_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `rotation_replay_response` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `rotation_replay_expires_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauth_client_resource_client_id` ON `oauthClientResource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_client_resource_resource_id` ON `oauthClientResource` (`resource_id`);