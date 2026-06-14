-- Grandfather organizations that already use enterprise features (SSO,
-- customized desktop policies, enforced SSO, or desktop version pinning)
-- onto the enterprise plan, so enabling DEN_PLAN_GATING_ENABLED never breaks
-- an existing organization. See docs/enterprise-plan-gating.md.
--
-- Idempotent: organizations already on the enterprise tier are skipped, and
-- organizations without enterprise-feature usage are untouched.
UPDATE `organization` `o`
SET `o`.`metadata` = JSON_SET(
  COALESCE(`o`.`metadata`, JSON_OBJECT()),
  '$.plan',
  JSON_OBJECT(
    'tier', 'enterprise',
    'source', 'grandfathered',
    'grandfatheredAt', DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
  )
)
WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`o`.`metadata`, '$.plan.tier')), '') <> 'enterprise'
  AND (
    EXISTS (
      SELECT 1 FROM `sso_connection` `sc` WHERE `sc`.`organization_id` = `o`.`id`
    )
    OR EXISTS (
      SELECT 1 FROM `desktop_policy_member` `dpm` WHERE `dpm`.`organization_id` = `o`.`id`
    )
    OR EXISTS (
      SELECT 1 FROM `desktop_policy` `dp`
      WHERE `dp`.`organization_id` = `o`.`id`
        AND `dp`.`deleted_at` IS NULL
        AND (
          `dp`.`is_default` IS NOT TRUE
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.allowCustomProviders')
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.allowZenModel')
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.allowMultipleWorkspaces')
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.allowControlSettings')
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.allowManageExtensions')
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.allowBuiltInExtensions')
          OR JSON_CONTAINS(`dp`.`policy`, 'false', '$.showWelcomePage')
        )
    )
    OR JSON_EXTRACT(`o`.`metadata`, '$.requireSso') = TRUE
    OR JSON_LENGTH(COALESCE(JSON_EXTRACT(`o`.`metadata`, '$.allowedDesktopVersions'), JSON_ARRAY())) > 0
  );
