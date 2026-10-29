-- The 14-key grant body from the administrator-recovery migration, without
-- historical recipient selection. Bootstrap creates the set for an explicitly
-- selected designated Admin team before executing this statement.
-- Existing user decisions in the Admin default set are not overridden.
INSERT INTO `permission_set_permission` (`id`, `organization_id`, `permission_set_id`, `permission_key`, `status`, `source`)
-- IDs and catalog keys are ASCII tokens. Hash their bytes so CONCAT does not
-- need to reconcile a table column's collation with the derived key literals.
SELECT CONCAT('psp_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', CAST(ps.`id` AS BINARY), ':', CAST(k.permission_key AS BINARY)), 256), 25)),
  ps.`organization_id`, ps.`id`, k.permission_key,
  IF(EXISTS (SELECT 1 FROM `permission_set` defaults
    JOIN `permission_set_permission` decision ON decision.`permission_set_id` = defaults.`id`
    WHERE defaults.`organization_id` = ps.`organization_id` AND defaults.`default_key` = 'admin'
      AND decision.`permission_key` = k.permission_key AND decision.`source` = 'user'), 'deny', 'allow'),
  'migration'
FROM `permission_set` ps
CROSS JOIN (
  SELECT 'organization.update' AS permission_key UNION ALL SELECT 'branding.update'
  UNION ALL SELECT 'web_origins.manage' UNION ALL SELECT 'members.update'
  UNION ALL SELECT 'teams.manage_admin' UNION ALL SELECT 'sso.manage'
  UNION ALL SELECT 'scim.manage' UNION ALL SELECT 'api_keys.manage'
  UNION ALL SELECT 'desktop_policies.manage' UNION ALL SELECT 'egress_diagnostics.manage'
  UNION ALL SELECT 'billing_portal.use' UNION ALL SELECT 'connections.update'
  UNION ALL SELECT 'connections.delete' UNION ALL SELECT 'permissions.manage'
) k
WHERE CAST(ps.`organization_id` AS BINARY) = CAST(@den_admin_recovery_org AS BINARY)
  -- SHA2 returns connection-charset text even for a latin1 input. IDs are
  -- ASCII tokens: compare bytes, as for the organization fence above, rather
  -- than asking the server to reconcile the column and hash collations.
  AND CAST(ps.`id` AS BINARY) = CAST(CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', CAST(ps.`organization_id` AS BINARY)), 256), 25)) AS BINARY)
  AND NOT EXISTS (SELECT 1 FROM `permission_set_permission` existing
    WHERE existing.`permission_set_id` = ps.`id` AND existing.`permission_key` = k.permission_key);
