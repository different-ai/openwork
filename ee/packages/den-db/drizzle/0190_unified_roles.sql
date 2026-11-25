-- Unified roles.
-- permission_set_member gives a permission set to one person directly, without
-- a team (a custom role or Billing manager). It starts empty: nobody's access
-- changes until a role is given this way.
-- permission_set.default_key gains 'billing-manager' for the built-in Billing
-- manager set. Appending an enum value is an in-place, metadata-only change in
-- MySQL and on PlanetScale, and existing rows keep their values. No rows are
-- written here: each organization's Billing manager set is created (seeded
-- with its catalog permissions) on first use by ensureDefaultPermissionSets,
-- as Member, Admin and Super admin are. Plain DDL only.
CREATE TABLE `permission_set_member` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`permission_set_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`created_by_org_membership_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`removed_at` timestamp(3),
	`removed_by_org_membership_id` varchar(64),
	CONSTRAINT `permission_set_member_id` PRIMARY KEY(`id`),
	CONSTRAINT `permission_set_member_set_member` UNIQUE(`permission_set_id`,`org_membership_id`)
);
--> statement-breakpoint
ALTER TABLE `permission_set` MODIFY COLUMN `default_key` enum('member','admin','super-admin','billing-manager');--> statement-breakpoint
CREATE INDEX `permission_set_member_organization_id` ON `permission_set_member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `permission_set_member_org_membership_id` ON `permission_set_member` (`org_membership_id`);