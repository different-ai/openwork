CREATE TABLE `session_sso_authentication` (
	`session_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`sso_provider_id` varchar(255) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `session_sso_authentication_session_id` PRIMARY KEY(`session_id`)
);
--> statement-breakpoint
CREATE INDEX `session_sso_authentication_org` ON `session_sso_authentication` (`organization_id`);--> statement-breakpoint
CREATE INDEX `session_sso_authentication_user` ON `session_sso_authentication` (`user_id`);