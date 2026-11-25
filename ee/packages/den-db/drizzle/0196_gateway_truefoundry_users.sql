CREATE TABLE `gateway_truefoundry_users` (
	`gateway_provider_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`message` text,
	`truefoundry_user_id` varchar(255),
	`truefoundry_user_created` timestamp(3),
	`token_id` varchar(128),
	`token_name` varchar(64),
	`credential_id` varchar(64),
	`model_group_id` varchar(64),
	`access_grant_id` varchar(64),
	`checked_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `gateway_truefoundry_users_pk` PRIMARY KEY(`gateway_provider_id`,`org_membership_id`)
);
--> statement-breakpoint
CREATE INDEX `gateway_truefoundry_users_member` ON `gateway_truefoundry_users` (`org_membership_id`);