-- multipleSsoConnections: an organization may have several SSO connections.
-- MySQL has no CREATE INDEX / ADD COLUMN IF NOT EXISTS, so each step checks
-- information_schema first (as 0004_organization_plugin does) and is safe to
-- run again. The new organization index is created before the unique one is
-- dropped, so lookups by organization always have an index during a rolling
-- deploy.
SET @has_sso_connection_organization := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'sso_connection'
    AND index_name = 'sso_connection_organization'
);
--> statement-breakpoint
SET @create_sso_connection_organization_sql := IF(
  @has_sso_connection_organization = 0,
  'CREATE INDEX `sso_connection_organization` ON `sso_connection` (`organization_id`,`created_at`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE create_sso_connection_organization_stmt FROM @create_sso_connection_organization_sql;
--> statement-breakpoint
EXECUTE create_sso_connection_organization_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE create_sso_connection_organization_stmt;
--> statement-breakpoint
SET @has_sso_connection_organization_id := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'sso_connection'
    AND index_name = 'sso_connection_organization_id'
);
--> statement-breakpoint
SET @drop_sso_connection_organization_id_sql := IF(
  @has_sso_connection_organization_id > 0,
  'ALTER TABLE `sso_connection` DROP INDEX `sso_connection_organization_id`',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE drop_sso_connection_organization_id_stmt FROM @drop_sso_connection_organization_id_sql;
--> statement-breakpoint
EXECUTE drop_sso_connection_organization_id_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE drop_sso_connection_organization_id_stmt;
--> statement-breakpoint
SET @has_sso_connection_name := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'sso_connection'
    AND column_name = 'name'
);
--> statement-breakpoint
SET @add_sso_connection_name_sql := IF(
  @has_sso_connection_name = 0,
  'ALTER TABLE `sso_connection` ADD `name` varchar(120)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE add_sso_connection_name_stmt FROM @add_sso_connection_name_sql;
--> statement-breakpoint
EXECUTE add_sso_connection_name_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE add_sso_connection_name_stmt;
