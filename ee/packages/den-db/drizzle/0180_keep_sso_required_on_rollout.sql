-- ssoPerOrganization: keep SSO required for organizations that have it today.
--
-- Until the flag is on for an organization, an enabled SSO connection on a
-- verified domain makes SSO the only way in, whatever `requireSso` holds (the
-- old settings screen saved `false` on every save). Once the flag is on,
-- `requireSso` decides. Record what these organizations get today so turning
-- the flag on never makes their SSO optional without an admin choosing it.
--
-- Organizations already effectively on the flag (their own override, or the
-- deployment-wide rollout without an override off, and no kill switch) keep
-- what their admins chose. Operator locks (DEN_FEATURE_SSO_PER_ORGANIZATION)
-- are not visible here; see docs/features/sso-per-organization/README.md.
UPDATE `organization` `o`
SET `o`.`metadata` = JSON_SET(
  CASE WHEN `o`.`metadata` IS NULL OR TRIM(`o`.`metadata`) = '' THEN JSON_OBJECT() ELSE `o`.`metadata` END,
  '$.requireSso',
  TRUE
)
WHERE (
    CASE
      WHEN `o`.`metadata` IS NULL OR TRIM(`o`.`metadata`) = '' THEN TRUE
      -- Unreadable metadata is left alone (the app reads it as empty).
      WHEN JSON_VALID(`o`.`metadata`) THEN COALESCE(JSON_EXTRACT(`o`.`metadata`, '$.requireSso') = TRUE, FALSE) = FALSE
      ELSE FALSE
    END
  )
  AND EXISTS (
    SELECT 1
    FROM `sso_connection` `c`
    JOIN `sso_provider` `p`
      ON `p`.`provider_id` = `c`.`provider_id`
     AND `p`.`organization_id` = `o`.`id`
     AND `p`.`domain_verified` = 1
    WHERE `c`.`organization_id` = `o`.`id`
      AND `c`.`status` = 'enabled'
  )
  AND NOT (
    COALESCE((SELECT `r`.`killed` FROM `feature_rollout` `r` WHERE `r`.`feature_key` = 'ssoPerOrganization'), FALSE) = FALSE
    AND COALESCE(
      (SELECT `f`.`enabled` FROM `organization_feature` `f` WHERE `f`.`organization_id` = `o`.`id` AND `f`.`feature_key` = 'ssoPerOrganization'),
      (SELECT `r`.`enabled` FROM `feature_rollout` `r` WHERE `r`.`feature_key` = 'ssoPerOrganization'),
      FALSE
    ) = TRUE
  );
