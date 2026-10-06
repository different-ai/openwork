CREATE TABLE `feature_rollout` (
	`feature_key` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`killed` boolean NOT NULL DEFAULT false,
	`updated_by_user_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `feature_rollout_feature_key` PRIMARY KEY(`feature_key`)
);
--> statement-breakpoint
CREATE TABLE `organization_feature` (
	`organization_id` varchar(64) NOT NULL,
	`feature_key` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`source` varchar(16) NOT NULL,
	`set_by_user_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `organization_feature_pk` PRIMARY KEY(`organization_id`,`feature_key`)
);
--> statement-breakpoint
-- Copy per-organization feature overrides out of organization.metadata.capabilities.
-- Only literal booleans were ever honored; anything else meant "use the default".
-- Some rows hold metadata double-encoded as a JSON string, so unwrap those first.
-- Idempotent: INSERT IGNORE never replaces a row that already exists.
INSERT IGNORE INTO `organization_feature` (`organization_id`, `feature_key`, `enabled`, `source`)
SELECT `o`.`id`, `k`.`feature_key`,
  JSON_EXTRACT(`o`.`doc`, CONCAT('$.capabilities.', `k`.`feature_key`)) = CAST('true' AS JSON),
  'migration'
FROM (
  SELECT `id`,
    CASE
      WHEN JSON_TYPE(`metadata`) = 'STRING' AND JSON_VALID(JSON_UNQUOTE(`metadata`)) THEN CAST(JSON_UNQUOTE(`metadata`) AS JSON)
      ELSE `metadata`
    END AS `doc`
  FROM `organization`
) AS `o`
JOIN (
  SELECT 'installLinks' AS `feature_key`
  UNION ALL SELECT 'mcpConnections'
  UNION ALL SELECT 'modelsAnalytics'
  UNION ALL SELECT 'auditLogs'
  UNION ALL SELECT 'orgManagedDashboards'
  UNION ALL SELECT 'slackAssistant'
  UNION ALL SELECT 'slackAssistantHeadless'
  UNION ALL SELECT 'headlessAutomations'
  UNION ALL SELECT 'workbot'
) AS `k`
WHERE JSON_TYPE(JSON_EXTRACT(`o`.`doc`, CONCAT('$.capabilities.', `k`.`feature_key`))) = 'BOOLEAN';
--> statement-breakpoint
-- Connect also honored two older flat aliases when capabilities.mcpConnections
-- was not a boolean: any literal true enabled it, otherwise a literal false disabled it.
INSERT IGNORE INTO `organization_feature` (`organization_id`, `feature_key`, `enabled`, `source`)
SELECT `o`.`id`, 'mcpConnections',
  JSON_EXTRACT(`o`.`doc`, '$.connectEnabled') <=> CAST('true' AS JSON)
    OR JSON_EXTRACT(`o`.`doc`, '$.mcpConnectionsEnabled') <=> CAST('true' AS JSON),
  'migration'
FROM (
  SELECT `id`,
    CASE
      WHEN JSON_TYPE(`metadata`) = 'STRING' AND JSON_VALID(JSON_UNQUOTE(`metadata`)) THEN CAST(JSON_UNQUOTE(`metadata`) AS JSON)
      ELSE `metadata`
    END AS `doc`
  FROM `organization`
) AS `o`
WHERE JSON_TYPE(JSON_EXTRACT(`o`.`doc`, '$.connectEnabled')) = 'BOOLEAN'
  OR JSON_TYPE(JSON_EXTRACT(`o`.`doc`, '$.mcpConnectionsEnabled')) = 'BOOLEAN';
