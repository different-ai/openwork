-- multipleSsoConnections: an organization may have several SSO connections.
-- Plain DDL only: production runs on PlanetScale (Vitess), which rejects user
-- variables with subqueries and PREPARE, and has no CREATE INDEX / ADD COLUMN
-- IF NOT EXISTS. Drizzle's migration journal applies this file once. The new
-- organization index is created before the unique one is dropped, so lookups by
-- organization always have an index during a rolling deploy.
CREATE INDEX `sso_connection_organization` ON `sso_connection` (`organization_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `sso_connection` DROP INDEX `sso_connection_organization_id`;--> statement-breakpoint
ALTER TABLE `sso_connection` ADD `name` varchar(120);
