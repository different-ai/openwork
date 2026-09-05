CREATE TABLE `dashboard_access_grant` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`dashboard_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64),
	`team_id` varchar(64),
	`org_wide` boolean NOT NULL DEFAULT false,
	`role` enum('viewer','editor','manager') NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`removed_at` timestamp(3),
	CONSTRAINT `dashboard_access_grant_id` PRIMARY KEY(`id`),
	CONSTRAINT `dashboard_access_grant_dashboard_org_membership` UNIQUE(`dashboard_id`,`org_membership_id`),
	CONSTRAINT `dashboard_access_grant_dashboard_team` UNIQUE(`dashboard_id`,`team_id`)
);
--> statement-breakpoint
CREATE TABLE `dashboard` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`elements_json` json NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`deleted_at` timestamp(3),
	CONSTRAINT `dashboard_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dashboard_access_grant_organization_id` ON `dashboard_access_grant` (`organization_id`);--> statement-breakpoint
CREATE INDEX `dashboard_access_grant_org_membership_id` ON `dashboard_access_grant` (`org_membership_id`);--> statement-breakpoint
CREATE INDEX `dashboard_access_grant_team_id` ON `dashboard_access_grant` (`team_id`);--> statement-breakpoint
CREATE INDEX `dashboard_access_grant_org_wide` ON `dashboard_access_grant` (`org_wide`);--> statement-breakpoint
CREATE INDEX `dashboard_organization_id` ON `dashboard` (`organization_id`);--> statement-breakpoint
CREATE INDEX `dashboard_created_by_org_membership_id` ON `dashboard` (`created_by_org_membership_id`);--> statement-breakpoint
CREATE INDEX `dashboard_name` ON `dashboard` (`name`);