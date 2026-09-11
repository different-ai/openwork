-- Registered forward migration. See 0097_gateway_access_matrix.md.
-- Execute every statement on ONE connection, stop on the first error, and
-- quiesce writers/callbacks/refreshes before starting. Requires schema through 0096.
-- No legacy inference key, OpenRouter, limit, bucket or ledger table is changed.
-- Guards fail BEFORE persistent DDL without CHECK, routines, SIGNAL or delimiters.
-- Metadata guards raise JSON error 3141; temporary primary-key guards retain
-- duplicate-key failures for version, SQL mode and data. Close the connection
-- on failure; fix the source deliberately, never IGNORE errors or delete rows.
CREATE TEMPORARY TABLE `__gateway_0097_preflight` (
  `failure` varchar(80) NOT NULL PRIMARY KEY
);
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`) VALUES
  ('0097_requires_mysql_8_0_16_or_later'),
  ('0097_requires_strict_sql_mode'),
  ('0097_requires_complete_0096_schema'),
  ('0097_gateway_tables_already_exist'),
  ('0097_missing_legacy_indexes'),
  ('0097_invalid_typeid'),
  ('0097_orphan_or_cross_org_resource'),
  ('0097_invalid_credential_subject'),
  ('0097_invalid_audience'),
  ('0097_duplicate_audience_grants');
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_requires_mysql_8_0_16_or_later'
WHERE VERSION() LIKE '%MariaDB%' OR VERSION() LIKE '%TiDB%' OR NOT (
  CAST(SUBSTRING_INDEX(VERSION(), '.', 1) AS UNSIGNED) > 8
  OR (CAST(SUBSTRING_INDEX(VERSION(), '.', 1) AS UNSIGNED) = 8 AND (
    CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(VERSION(), '.', 2), '.', -1) AS UNSIGNED) > 0
    OR CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(VERSION(), '.', 3), '.', -1), '-', 1) AS UNSIGNED) >= 16
  ))
);
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_requires_strict_sql_mode'
WHERE FIND_IN_SET('STRICT_ALL_TABLES', @@SESSION.sql_mode) = 0
  AND FIND_IN_SET('STRICT_TRANS_TABLES', @@SESSION.sql_mode) = 0;
--> statement-breakpoint
-- Vitess metadata queries must stay flat SELECTs: no joins, subqueries or DML.
-- Invalid JSON raises ER_INVALID_JSON_TEXT_IN_PARAM (3141), not a warning, so
-- Drizzle stops before persistent DDL. Success returns {} rather than no rows.
SELECT JSON_EXTRACT(IF(COUNT(*) = 8, '{}', '0097_requires_complete_0096_schema'), '$') AS preflight
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME IN (
  'inference_providers', 'inference_provider_models', 'inference_provider_credentials',
  'inference_provider_access', 'inference_provider_oauth_states',
  'inference_request_logs', 'inference_usage_rollups', 'inference_rollup_lock'
);
--> statement-breakpoint
SELECT JSON_EXTRACT(IF(COUNT(*) = 11, '{}', '0097_requires_complete_0096_schema'), '$') AS preflight
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inference_usage_rollups'
  AND COLUMN_NAME IN ('input_tokens_count', 'output_tokens_count', 'total_tokens_count',
    'cache_read_tokens_count', 'cache_write_tokens_count', 'reasoning_tokens_count',
    'cost_count', 'latency_count', 'ttfb_count', 'request_bytes_count', 'response_bytes_count');
--> statement-breakpoint
SELECT JSON_EXTRACT(IF(COUNT(*) = 1, '{}', '0097_requires_complete_0096_schema'), '$') AS preflight
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inference_keys' AND COLUMN_NAME = 'encrypted_key';
--> statement-breakpoint
SELECT JSON_EXTRACT(IF(COUNT(*) = 0, '{}', '0097_gateway_tables_already_exist'), '$') AS preflight
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (
  'gateway_providers', 'gateway_provider_models', 'gateway_provider_credentials',
  'gateway_provider_access', 'gateway_provider_oauth_states', 'gateway_request_logs',
  'gateway_usage_rollups', 'gateway_rollup_lock', 'gateway_keys', 'gateway_model_groups',
  'gateway_model_group_models', 'gateway_credential_sets'
);
--> statement-breakpoint
SELECT JSON_EXTRACT(IF(COUNT(DISTINCT TABLE_NAME, INDEX_NAME) = 20, '{}', '0097_missing_legacy_indexes'), '$') AS preflight
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND (
  (TABLE_NAME = 'inference_providers' AND INDEX_NAME = 'inference_providers_organization_id')
  OR (TABLE_NAME = 'inference_providers' AND INDEX_NAME = 'inference_providers_org_provider_id')
  OR (TABLE_NAME = 'inference_provider_models' AND INDEX_NAME = 'inference_provider_models_model_id')
  OR (TABLE_NAME = 'inference_provider_models' AND INDEX_NAME = 'inference_provider_models_provider_model')
  OR (TABLE_NAME = 'inference_provider_credentials' AND INDEX_NAME = 'inference_provider_credentials_org_membership_id')
  OR (TABLE_NAME = 'inference_provider_credentials' AND INDEX_NAME = 'inference_provider_credentials_organization_id')
  OR (TABLE_NAME = 'inference_provider_credentials' AND INDEX_NAME = 'inference_provider_credentials_provider_subject')
  OR (TABLE_NAME = 'inference_provider_access' AND INDEX_NAME = 'inference_provider_access_org_membership_id')
  OR (TABLE_NAME = 'inference_provider_access' AND INDEX_NAME = 'inference_provider_access_team_id')
  OR (TABLE_NAME = 'inference_provider_access' AND INDEX_NAME = 'inference_provider_access_provider_org_membership')
  OR (TABLE_NAME = 'inference_provider_access' AND INDEX_NAME = 'inference_provider_access_provider_team')
  OR (TABLE_NAME = 'inference_provider_oauth_states' AND INDEX_NAME = 'inference_provider_oauth_states_state')
  OR (TABLE_NAME = 'inference_provider_oauth_states' AND INDEX_NAME = 'inference_provider_oauth_states_expires_at')
  OR (TABLE_NAME = 'inference_request_logs' AND INDEX_NAME = 'inference_request_logs_openwork_request_id')
  OR (TABLE_NAME = 'inference_request_logs' AND INDEX_NAME = 'inference_request_logs_org_started')
  OR (TABLE_NAME = 'inference_request_logs' AND INDEX_NAME = 'inference_request_logs_member_started')
  OR (TABLE_NAME = 'inference_request_logs' AND INDEX_NAME = 'inference_request_logs_provider_started')
  OR (TABLE_NAME = 'inference_request_logs' AND INDEX_NAME = 'inference_request_logs_started_at')
  OR (TABLE_NAME = 'inference_usage_rollups' AND INDEX_NAME = 'inference_usage_rollups_bucket_dimension')
  OR (TABLE_NAME = 'inference_usage_rollups' AND INDEX_NAME = 'inference_usage_rollups_org_granularity_bucket')
);
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_invalid_typeid'
WHERE EXISTS (
  SELECT 1 FROM (
    SELECT id AS value, 'ipr' AS prefix FROM inference_providers
    UNION ALL SELECT organization_id, 'org' FROM inference_providers
    UNION ALL SELECT created_by_org_membership_id, 'om' FROM inference_providers
    UNION ALL SELECT id, 'ipm' FROM inference_provider_models
    UNION ALL SELECT inference_provider_id, 'ipr' FROM inference_provider_models
    UNION ALL SELECT id, 'ipc' FROM inference_provider_credentials
    UNION ALL SELECT inference_provider_id, 'ipr' FROM inference_provider_credentials
    UNION ALL SELECT organization_id, 'org' FROM inference_provider_credentials
    UNION ALL SELECT org_membership_id, 'om' FROM inference_provider_credentials WHERE org_membership_id IS NOT NULL
    UNION ALL SELECT id, 'ipa' FROM inference_provider_access
    UNION ALL SELECT inference_provider_id, 'ipr' FROM inference_provider_access
    UNION ALL SELECT org_membership_id, 'om' FROM inference_provider_access WHERE org_membership_id IS NOT NULL
    UNION ALL SELECT team_id, 'tem' FROM inference_provider_access WHERE team_id IS NOT NULL
    UNION ALL SELECT id, 'ipos' FROM inference_provider_oauth_states
    UNION ALL SELECT inference_provider_id, 'ipr' FROM inference_provider_oauth_states
    UNION ALL SELECT org_membership_id, 'om' FROM inference_provider_oauth_states
    UNION ALL SELECT id, 'irl' FROM inference_request_logs
    UNION ALL SELECT id, 'iur' FROM inference_usage_rollups
  ) ids
  WHERE CHAR_LENGTH(value) <> CHAR_LENGTH(prefix) + 27
    OR NOT REGEXP_LIKE(value, CONCAT('^', prefix, '_[0-7][0-9a-hjkmnp-tv-z]{25}$'), 'c')
);
--> statement-breakpoint
-- History may reference retired resources. Only operational children require
-- live parents; logs and rollups retain their historical references untouched.
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_orphan_or_cross_org_resource'
WHERE EXISTS (
  SELECT 1 FROM inference_providers p
  LEFT JOIN organization o ON o.id = p.organization_id
  LEFT JOIN `member` m ON m.id = p.created_by_org_membership_id
  WHERE o.id IS NULL OR m.id IS NULL OR m.organization_id <> p.organization_id
) OR EXISTS (
  SELECT 1 FROM inference_provider_models m
  LEFT JOIN inference_providers p ON p.id = m.inference_provider_id WHERE p.id IS NULL
) OR EXISTS (
  SELECT 1 FROM inference_provider_credentials c
  LEFT JOIN inference_providers p ON p.id = c.inference_provider_id
  LEFT JOIN `member` m ON m.id = c.org_membership_id
  WHERE p.id IS NULL OR p.organization_id <> c.organization_id
    OR (c.org_membership_id IS NOT NULL AND (m.id IS NULL OR m.organization_id <> p.organization_id))
) OR EXISTS (
  SELECT 1 FROM inference_provider_access a
  LEFT JOIN inference_providers p ON p.id = a.inference_provider_id
  LEFT JOIN `member` m ON m.id = a.org_membership_id
  LEFT JOIN team t ON t.id = a.team_id
  WHERE p.id IS NULL
    OR (a.org_membership_id IS NOT NULL AND (m.id IS NULL OR m.organization_id <> p.organization_id))
    OR (a.team_id IS NOT NULL AND (t.id IS NULL OR t.organization_id <> p.organization_id))
) OR EXISTS (
  SELECT 1 FROM inference_provider_oauth_states s
  LEFT JOIN inference_providers p ON p.id = s.inference_provider_id
  LEFT JOIN `member` m ON m.id = s.org_membership_id
  WHERE p.id IS NULL OR m.id IS NULL OR m.organization_id <> p.organization_id
);
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_invalid_credential_subject'
WHERE EXISTS (
  SELECT 1 FROM inference_provider_credentials
  WHERE (org_membership_id IS NULL AND BINARY subject <> BINARY 'org')
    OR (org_membership_id IS NOT NULL AND BINARY subject <> BINARY org_membership_id)
) OR EXISTS (
  SELECT 1 FROM inference_provider_credentials
  GROUP BY inference_provider_id, subject HAVING COUNT(*) > 1
);
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_invalid_audience'
WHERE EXISTS (
  SELECT 1 FROM inference_provider_access WHERE org_membership_id IS NOT NULL AND team_id IS NOT NULL
);
--> statement-breakpoint
INSERT INTO `__gateway_0097_preflight` (`failure`)
SELECT '0097_duplicate_audience_grants'
WHERE EXISTS (
  SELECT 1 FROM inference_provider_access
  GROUP BY inference_provider_id, org_membership_id, team_id HAVING COUNT(*) > 1
);
--> statement-breakpoint
DROP TEMPORARY TABLE `__gateway_0097_preflight`;
--> statement-breakpoint
-- All preflight statements succeeded. Persistent DDL starts here.
RENAME TABLE
  `inference_providers` TO `gateway_providers`,
  `inference_provider_models` TO `gateway_provider_models`,
  `inference_provider_credentials` TO `gateway_provider_credentials`,
  `inference_provider_access` TO `gateway_provider_access`,
  `inference_provider_oauth_states` TO `gateway_provider_oauth_states`,
  `inference_request_logs` TO `gateway_request_logs`,
  `inference_usage_rollups` TO `gateway_usage_rollups`,
  `inference_rollup_lock` TO `gateway_rollup_lock`;
--> statement-breakpoint
ALTER TABLE `gateway_providers`
  RENAME INDEX `inference_providers_organization_id` TO `gateway_providers_organization_id`,
  RENAME INDEX `inference_providers_org_provider_id` TO `gateway_providers_org_provider_id`;
--> statement-breakpoint
ALTER TABLE `gateway_provider_models`
  CHANGE COLUMN `inference_provider_id` `gateway_provider_id` varchar(64) NOT NULL,
  RENAME INDEX `inference_provider_models_model_id` TO `gateway_provider_models_model_id`,
  RENAME INDEX `inference_provider_models_provider_model` TO `gateway_provider_models_provider_model`;
--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials`
  CHANGE COLUMN `inference_provider_id` `gateway_provider_id` varchar(64) NOT NULL,
  RENAME INDEX `inference_provider_credentials_org_membership_id` TO `gateway_provider_credentials_org_membership_id`,
  RENAME INDEX `inference_provider_credentials_organization_id` TO `gateway_provider_credentials_organization_id`;
--> statement-breakpoint
ALTER TABLE `gateway_provider_access`
  CHANGE COLUMN `inference_provider_id` `gateway_provider_id` varchar(64) NOT NULL,
  RENAME INDEX `inference_provider_access_org_membership_id` TO `gateway_provider_access_org_membership_id`,
  RENAME INDEX `inference_provider_access_team_id` TO `gateway_provider_access_team_id`;
--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states`
  CHANGE COLUMN `inference_provider_id` `gateway_provider_id` varchar(64) NOT NULL,
  RENAME INDEX `inference_provider_oauth_states_state` TO `gateway_provider_oauth_states_state`,
  RENAME INDEX `inference_provider_oauth_states_expires_at` TO `gateway_provider_oauth_states_expires_at`;
--> statement-breakpoint
ALTER TABLE `gateway_request_logs`
  CHANGE COLUMN `inference_provider_id` `gateway_provider_id` varchar(64),
  CHANGE COLUMN `inference_provider_credential_id` `gateway_provider_credential_id` varchar(64),
  MODIFY COLUMN `inference_key_id` varchar(64) NULL,
  ADD COLUMN `gateway_key_id` varchar(64),
  ADD COLUMN `model_group_id` varchar(64),
  ADD COLUMN `credential_set_id` varchar(64),
  ADD COLUMN `access_grant_id` varchar(64),
  RENAME INDEX `inference_request_logs_openwork_request_id` TO `gateway_request_logs_openwork_request_id`,
  RENAME INDEX `inference_request_logs_org_started` TO `gateway_request_logs_org_started`,
  RENAME INDEX `inference_request_logs_member_started` TO `gateway_request_logs_member_started`,
  RENAME INDEX `inference_request_logs_provider_started` TO `gateway_request_logs_provider_started`,
  RENAME INDEX `inference_request_logs_started_at` TO `gateway_request_logs_started_at`;
--> statement-breakpoint
-- Leave historical dimension_key bytes and new NULL dimensions untouched.
ALTER TABLE `gateway_usage_rollups`
  CHANGE COLUMN `inference_provider_id` `gateway_provider_id` varchar(64),
  ADD COLUMN `model_group_id` varchar(64),
  ADD COLUMN `credential_set_id` varchar(64),
  ADD COLUMN `access_grant_id` varchar(64),
  RENAME INDEX `inference_usage_rollups_bucket_dimension` TO `gateway_usage_rollups_bucket_dimension`,
  RENAME INDEX `inference_usage_rollups_org_granularity_bucket` TO `gateway_usage_rollups_org_granularity_bucket`;
--> statement-breakpoint
CREATE TABLE `gateway_keys` (
  `id` varchar(64) NOT NULL,
  `organization_id` varchar(64) NOT NULL,
  `org_membership_id` varchar(64) NOT NULL,
  `encrypted_key` text NOT NULL,
  `key_hash` varchar(64) NOT NULL,
  `key_prefix` varchar(32) NOT NULL,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `revoked_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `gateway_keys_id` PRIMARY KEY (`id`),
  CONSTRAINT `gateway_keys_org_member` UNIQUE (`organization_id`,`org_membership_id`),
  CONSTRAINT `gateway_keys_key_hash` UNIQUE (`key_hash`),
  INDEX `gateway_keys_org_membership_id` (`org_membership_id`),
  INDEX `gateway_keys_status` (`status`)
);
--> statement-breakpoint
CREATE TABLE `gateway_model_groups` (
  `id` varchar(64) NOT NULL,
  `gateway_provider_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `gateway_model_groups_id` PRIMARY KEY (`id`),
  INDEX `gateway_model_groups_provider_id` (`gateway_provider_id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_model_group_models` (
  `id` varchar(64) NOT NULL,
  `model_group_id` varchar(64) NOT NULL,
  `gateway_provider_model_id` varchar(64) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `gateway_model_group_models_id` PRIMARY KEY (`id`),
  CONSTRAINT `gateway_model_group_models_group_model` UNIQUE (`model_group_id`,`gateway_provider_model_id`),
  INDEX `gateway_model_group_models_model_id` (`gateway_provider_model_id`)
);
--> statement-breakpoint
CREATE TABLE `gateway_credential_sets` (
  `id` varchar(64) NOT NULL,
  `gateway_provider_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `credential_mode` enum('org','member') NOT NULL,
  `oauth_client_id` varchar(255),
  `oauth_client_secret` text,
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `gateway_credential_sets_id` PRIMARY KEY (`id`),
  INDEX `gateway_credential_sets_provider_id` (`gateway_provider_id`)
);
--> statement-breakpoint
INSERT INTO `gateway_model_groups`
  (`id`,`gateway_provider_id`,`name`,`description`,`status`,`created_at`,`updated_at`)
SELECT CONCAT('gmg_', SUBSTRING(`id`, 5)), `id`, 'All configured models', NULL,
  'active', `created_at`, `updated_at`
FROM `gateway_providers`;
--> statement-breakpoint
-- AES-GCM encryption is not table/row-bound. Copy the ciphertext verbatim;
-- do not decrypt/re-encrypt it or change concrete credential secrets.
INSERT INTO `gateway_credential_sets`
  (`id`,`gateway_provider_id`,`name`,`credential_mode`,`oauth_client_id`,`oauth_client_secret`,`status`,`created_at`,`updated_at`)
SELECT CONCAT('gcs_', SUBSTRING(`id`, 5)), `id`, 'Default credentials',
  `credential_mode`, `oauth_client_id`, `oauth_client_secret`, 'active', `created_at`, `updated_at`
FROM `gateway_providers`;
--> statement-breakpoint
INSERT INTO `gateway_model_group_models`
  (`id`,`model_group_id`,`gateway_provider_model_id`,`created_at`)
SELECT CONCAT('gmm_', SUBSTRING(m.`id`, 5)), g.`id`, m.`id`, m.`created_at`
FROM `gateway_provider_models` m
JOIN `gateway_model_groups` g ON g.`gateway_provider_id` = m.`gateway_provider_id`;
--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials` ADD COLUMN `credential_set_id` varchar(64) NULL;
--> statement-breakpoint
ALTER TABLE `gateway_provider_access`
  ADD COLUMN `model_group_id` varchar(64) NULL,
  ADD COLUMN `credential_set_id` varchar(64) NULL,
  ADD COLUMN `audience_key` varchar(80) NULL;
--> statement-breakpoint
ALTER TABLE `gateway_provider_oauth_states` ADD COLUMN `credential_set_id` varchar(64) NULL;
--> statement-breakpoint
UPDATE `gateway_provider_credentials` c
JOIN `gateway_credential_sets` s ON s.`gateway_provider_id` = c.`gateway_provider_id`
SET c.`credential_set_id` = s.`id`, c.`updated_at` = c.`updated_at`
WHERE c.`credential_set_id` IS NULL;
--> statement-breakpoint
UPDATE `gateway_provider_access` a
JOIN `gateway_model_groups` g ON g.`gateway_provider_id` = a.`gateway_provider_id`
JOIN `gateway_credential_sets` s ON s.`gateway_provider_id` = a.`gateway_provider_id`
SET a.`model_group_id` = g.`id`, a.`credential_set_id` = s.`id`,
  a.`audience_key` = CASE
    WHEN a.`org_membership_id` IS NOT NULL THEN CONCAT('member:', a.`org_membership_id`)
    WHEN a.`team_id` IS NOT NULL THEN CONCAT('team:', a.`team_id`)
    ELSE 'organization' END
WHERE a.`model_group_id` IS NULL AND a.`credential_set_id` IS NULL;
--> statement-breakpoint
UPDATE `gateway_provider_oauth_states` o
JOIN `gateway_credential_sets` s ON s.`gateway_provider_id` = o.`gateway_provider_id`
SET o.`credential_set_id` = s.`id`
WHERE o.`credential_set_id` IS NULL;
--> statement-breakpoint
-- Old states never captured a set/client revision. Their compatibility cannot
-- be proven offline. Require fresh consent; preserve verifier/token rows.
UPDATE `gateway_provider_oauth_states` SET `used_at` = CURRENT_TIMESTAMP(3) WHERE `used_at` IS NULL;
--> statement-breakpoint
ALTER TABLE `gateway_provider_credentials`
  MODIFY COLUMN `credential_set_id` varchar(64) NOT NULL,
  ADD CONSTRAINT `gateway_provider_credentials_set_subject` UNIQUE (`credential_set_id`,`subject`),
  ADD INDEX `gateway_provider_credentials_provider_id` (`gateway_provider_id`),
  DROP INDEX `inference_provider_credentials_provider_subject`;
--> statement-breakpoint
ALTER TABLE `gateway_provider_access`
  MODIFY COLUMN `model_group_id` varchar(64) NOT NULL,
  MODIFY COLUMN `credential_set_id` varchar(64) NOT NULL,
  MODIFY COLUMN `audience_key` varchar(80) NOT NULL,
  ADD CONSTRAINT `gateway_provider_access_audience` CHECK (
    (`org_membership_id` IS NULL OR `team_id` IS NULL)
    AND `audience_key` = CASE
      WHEN `org_membership_id` IS NOT NULL THEN CONCAT('member:', `org_membership_id`)
      WHEN `team_id` IS NOT NULL THEN CONCAT('team:', `team_id`)
      ELSE 'organization' END
  ),
  ADD CONSTRAINT `gateway_provider_access_audience_group_set` UNIQUE (`gateway_provider_id`,`audience_key`,`model_group_id`,`credential_set_id`),
  ADD INDEX `gateway_provider_access_credential_set_id` (`credential_set_id`),
  ADD INDEX `gateway_provider_access_model_group_id` (`model_group_id`),
  DROP INDEX `inference_provider_access_provider_org_membership`,
  DROP INDEX `inference_provider_access_provider_team`;
--> statement-breakpoint
-- gateway_keys intentionally stays empty. Mint ow_gw_ keys on the next
-- authorized runtime connect, rotating the stable organization/member row.
ALTER TABLE `gateway_provider_oauth_states`
  MODIFY COLUMN `credential_set_id` varchar(64) NOT NULL,
  ADD INDEX `gateway_provider_oauth_states_set_member` (`credential_set_id`,`org_membership_id`);
