-- Manual SQL variant for MySQL/Vitess consoles.
-- - No `--> statement-breakpoint` markers
-- - No PREPARE/EXECUTE dynamic SQL
-- - Avoids `ADD COLUMN IF NOT EXISTS` (not supported in some Vitess setups)

-- Run these only if the columns are missing.
-- Check first:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = DATABASE() AND table_name = 'session'
--   AND column_name IN ('active_organization_id', 'active_team_id');

ALTER TABLE `session`
  ADD COLUMN `active_organization_id` varchar(64) NULL;

ALTER TABLE `session`
  ADD COLUMN `active_team_id` varchar(64) NULL;

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

-- Optional legacy backfill. Run only if these legacy tables exist:
--   org
--   org_membership
--
-- INSERT INTO `organization` (`id`, `name`, `slug`, `logo`, `metadata`, `created_at`, `updated_at`)
-- SELECT `id`, `name`, `slug`, NULL, NULL, `created_at`, `updated_at`
-- FROM `org`
-- WHERE `id` NOT IN (SELECT `id` FROM `organization`);
--
-- INSERT INTO `member` (`id`, `organization_id`, `user_id`, `role`, `created_at`)
-- SELECT `id`, `org_id`, `user_id`, `role`, `created_at`
-- FROM `org_membership`
-- WHERE `id` NOT IN (SELECT `id` FROM `member`);
