CREATE TABLE `model_promotion_audit` (
	`id` varchar(36) NOT NULL,
	`campaign_id` varchar(36) NOT NULL,
	`actor_id` varchar(64) NOT NULL,
	`action` varchar(64) NOT NULL,
	`subject_id` varchar(255),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `model_promotion_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `model_promotion_grants` (
	`id` varchar(36) NOT NULL,
	`campaign_id` varchar(36) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL,
	`terms` json NOT NULL,
	`terms_version` int NOT NULL,
	`credit_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`spent_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`reserved_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`stripe_session_id` varchar(255),
	`stripe_subscription_id` varchar(255),
	`stripe_invoice_id` varchar(255),
	`paid_at` timestamp(3),
	`activate_by` timestamp(3),
	`expires_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `model_promotion_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_grant_user` UNIQUE(`campaign_id`,`user_id`),
	CONSTRAINT `model_grant_org` UNIQUE(`campaign_id`,`organization_id`),
	CONSTRAINT `model_grant_session` UNIQUE(`stripe_session_id`)
);
--> statement-breakpoint
CREATE TABLE `model_promotion_requests` (
	`id` varchar(36) NOT NULL,
	`campaign_id` varchar(36) NOT NULL,
	`grant_id` varchar(36) NOT NULL,
	`status` varchar(16) NOT NULL,
	`reserved_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`cost_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`generation_id` varchar(255),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `model_promotion_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `model_promotions` (
	`id` varchar(36) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`alias` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`status` varchar(16) NOT NULL DEFAULT 'draft',
	`terms` json NOT NULL,
	`encrypted_key` text NOT NULL,
	`key_fingerprint` varchar(64) NOT NULL,
	`claimed` int NOT NULL DEFAULT 0,
	`spent_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`reserved_microusd` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `model_promotions_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_promotion_slug` UNIQUE(`slug`),
	CONSTRAINT `model_promotion_alias` UNIQUE(`alias`),
	CONSTRAINT `model_promotion_key` UNIQUE(`key_fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `model_promotion_visits` (
	`token_hash` varchar(64) NOT NULL,
	`campaign_id` varchar(36) NOT NULL,
	`claimed_by` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `model_promotion_visits_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `model_promo_audit_time` ON `model_promotion_audit` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `model_grant_subscription` ON `model_promotion_grants` (`stripe_subscription_id`);--> statement-breakpoint
CREATE INDEX `model_request_grant_time` ON `model_promotion_requests` (`grant_id`,`created_at`);