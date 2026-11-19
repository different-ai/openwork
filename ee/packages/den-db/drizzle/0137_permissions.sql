CREATE TABLE `permission_set_permission` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`permission_set_id` varchar(64) NOT NULL,
	`permission_key` varchar(128) NOT NULL,
	`status` enum('allow','deny') NOT NULL,
	`source` enum('user','seed','reconcile','migration') NOT NULL,
	`changed_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `permission_set_permission_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `permission_set` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`default_key` enum('member','admin'),
	`name` varchar(255) NOT NULL,
	`created_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	`archived_at` timestamp(3),
	`archived_by_org_membership_id` varchar(64),
	CONSTRAINT `permission_set_id` PRIMARY KEY(`id`),
	CONSTRAINT `permission_set_org_default_key` UNIQUE(`organization_id`,`default_key`)
);
--> statement-breakpoint
CREATE TABLE `permission_set_team` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`permission_set_id` varchar(64) NOT NULL,
	`team_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`removed_at` timestamp(3),
	`removed_by_org_membership_id` varchar(64),
	CONSTRAINT `permission_set_team_id` PRIMARY KEY(`id`),
	CONSTRAINT `permission_set_team_set_team` UNIQUE(`permission_set_id`,`team_id`)
);
--> statement-breakpoint
CREATE INDEX `permission_set_permission_set_key_created` ON `permission_set_permission` (`permission_set_id`,`permission_key`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `permission_set_permission_organization_id` ON `permission_set_permission` (`organization_id`);--> statement-breakpoint
CREATE INDEX `permission_set_organization_id` ON `permission_set` (`organization_id`);--> statement-breakpoint
CREATE INDEX `permission_set_team_organization_id` ON `permission_set_team` (`organization_id`);--> statement-breakpoint
CREATE INDEX `permission_set_team_team_id` ON `permission_set_team` (`team_id`);