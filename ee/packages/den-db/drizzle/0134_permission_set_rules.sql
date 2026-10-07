CREATE TABLE `permission_set_rule` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`permission_set_id` varchar(64) NOT NULL,
	`action` enum('shell','webfetch','skill','mcp') NOT NULL,
	`rules` json NOT NULL,
	`source` enum('user','seed','reconcile','migration') NOT NULL,
	`changed_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `permission_set_rule_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `permission_set_rule_set_action_created` ON `permission_set_rule` (`permission_set_id`,`action`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `permission_set_rule_organization_id` ON `permission_set_rule` (`organization_id`);