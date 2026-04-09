SET @has_active_organization_id := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'session'
    AND column_name = 'active_organization_id'
);
--> statement-breakpoint
SET @add_active_organization_id_sql := IF(
  @has_active_organization_id = 0,
  'ALTER TABLE `session` ADD COLUMN `active_organization_id` varchar(64) NULL',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE add_active_organization_id_stmt FROM @add_active_organization_id_sql;
--> statement-breakpoint
EXECUTE add_active_organization_id_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE add_active_organization_id_stmt;
--> statement-breakpoint
SET @has_active_team_id := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'session'
    AND column_name = 'active_team_id'
);
--> statement-breakpoint
SET @add_active_team_id_sql := IF(
  @has_active_team_id = 0,
  'ALTER TABLE `session` ADD COLUMN `active_team_id` varchar(64) NULL',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE add_active_team_id_stmt FROM @add_active_team_id_sql;
--> statement-breakpoint
EXECUTE add_active_team_id_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE add_active_team_id_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organization` (
  `id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `slug` varchar(255) NOT NULL,
  `logo` varchar(2048),
  `metadata` text,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `organization_id` PRIMARY KEY(`id`),
  CONSTRAINT `organization_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `member` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `role` varchar(255) NOT NULL DEFAULT 'member',
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `member_id` PRIMARY KEY(`id`),
  CONSTRAINT `member_organization_user` UNIQUE(`organization_id`, `user_id`),
  KEY `member_organization_id` (`organization_id`),
  KEY `member_user_id` (`user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invitation` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `role` varchar(255) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'pending',
  `team_id` varchar(64) DEFAULT NULL,
  `inviter_id` varchar(64) NOT NULL,
  `expires_at` timestamp(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `invitation_id` PRIMARY KEY(`id`),
  KEY `invitation_organization_id` (`organization_id`),
  KEY `invitation_email` (`email`),
  KEY `invitation_status` (`status`),
  KEY `invitation_team_id` (`team_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team` (
  `id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_organization_name` UNIQUE(`organization_id`, `name`),
  KEY `team_organization_id` (`organization_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_member` (
  `id` varchar(64) NOT NULL,
  `team_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `team_member_id` PRIMARY KEY(`id`),
  CONSTRAINT `team_member_team_user` UNIQUE(`team_id`, `user_id`),
  KEY `team_member_team_id` (`team_id`),
  KEY `team_member_user_id` (`user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organization_role` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `role` varchar(255) NOT NULL,
  `permission` text NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `organization_role_id` PRIMARY KEY(`id`),
  CONSTRAINT `organization_role_name` UNIQUE(`organization_id`, `role`),
  KEY `organization_role_organization_id` (`organization_id`)
);
--> statement-breakpoint
SET @has_legacy_org_table := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'org'
);
--> statement-breakpoint
SET @copy_legacy_org_sql := IF(
  @has_legacy_org_table > 0,
  'INSERT INTO `organization` (`id`, `name`, `slug`, `logo`, `metadata`, `created_at`, `updated_at`) SELECT `id`, `name`, `slug`, NULL, NULL, `created_at`, `updated_at` FROM `org` WHERE `id` NOT IN (SELECT `id` FROM `organization`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE copy_legacy_org_stmt FROM @copy_legacy_org_sql;
--> statement-breakpoint
EXECUTE copy_legacy_org_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE copy_legacy_org_stmt;
--> statement-breakpoint
SET @has_legacy_org_membership_table := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'org_membership'
);
--> statement-breakpoint
SET @copy_legacy_org_membership_sql := IF(
  @has_legacy_org_membership_table > 0,
  'INSERT INTO `member` (`id`, `organization_id`, `user_id`, `role`, `created_at`) SELECT `id`, `org_id`, `user_id`, `role`, `created_at` FROM `org_membership` WHERE `id` NOT IN (SELECT `id` FROM `member`)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE copy_legacy_org_membership_stmt FROM @copy_legacy_org_membership_sql;
--> statement-breakpoint
EXECUTE copy_legacy_org_membership_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE copy_legacy_org_membership_stmt;
