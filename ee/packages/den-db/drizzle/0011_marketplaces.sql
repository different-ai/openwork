CREATE TABLE IF NOT EXISTS `marketplace` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `status` enum('active','inactive','deleted','archived') NOT NULL DEFAULT 'active',
  `created_by_org_membership_id` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at` timestamp(3) NULL,
  CONSTRAINT `marketplace_id` PRIMARY KEY(`id`),
  KEY `marketplace_organization_id` (`organization_id`),
  KEY `marketplace_created_by_org_membership_id` (`created_by_org_membership_id`),
  KEY `marketplace_status` (`status`),
  KEY `marketplace_name` (`name`)
);

CREATE TABLE IF NOT EXISTS `marketplace_plugin` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `marketplace_id` varchar(64) NOT NULL,
  `plugin_id` varchar(64) NOT NULL,
  `membership_source` enum('manual','connector','api','system') NOT NULL DEFAULT 'manual',
  `created_by_org_membership_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `removed_at` timestamp(3) NULL,
  CONSTRAINT `marketplace_plugin_id` PRIMARY KEY(`id`),
  CONSTRAINT `marketplace_plugin_marketplace_plugin` UNIQUE(`marketplace_id`, `plugin_id`),
  KEY `marketplace_plugin_organization_id` (`organization_id`),
  KEY `marketplace_plugin_marketplace_id` (`marketplace_id`),
  KEY `marketplace_plugin_plugin_id` (`plugin_id`)
);

CREATE TABLE IF NOT EXISTS `marketplace_access_grant` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `marketplace_id` varchar(64) NOT NULL,
  `org_membership_id` varchar(64),
  `team_id` varchar(64),
  `org_wide` boolean NOT NULL DEFAULT false,
  `role` enum('viewer','editor','manager') NOT NULL,
  `created_by_org_membership_id` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `removed_at` timestamp(3) NULL,
  CONSTRAINT `marketplace_access_grant_id` PRIMARY KEY(`id`),
  CONSTRAINT `marketplace_access_grant_marketplace_org_membership` UNIQUE(`marketplace_id`, `org_membership_id`),
  CONSTRAINT `marketplace_access_grant_marketplace_team` UNIQUE(`marketplace_id`, `team_id`),
  KEY `marketplace_access_grant_organization_id` (`organization_id`),
  KEY `marketplace_access_grant_marketplace_id` (`marketplace_id`),
  KEY `marketplace_access_grant_org_membership_id` (`org_membership_id`),
  KEY `marketplace_access_grant_team_id` (`team_id`),
  KEY `marketplace_access_grant_org_wide` (`org_wide`)
);
