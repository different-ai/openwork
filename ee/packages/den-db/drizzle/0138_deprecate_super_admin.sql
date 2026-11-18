-- Preserve the authoritative, current super-admin roster BEFORE rewriting roles.
-- 0137 has created Permissions storage. This is an ordinary team and custom set,
-- not a new built-in role or a change to Admin defaults. No historical inference.
-- Owners retain all permissions without this team; removed/disconnected members
-- and pending invitations/claims must not acquire a grant.
-- Stable valid TypeIDs make retries safe. Memberships precede the set deliberately
-- (there are no foreign keys). The set, including its archived tombstone, fences
-- re-enrollment after owner edits. The final binding activates the grant.
INSERT INTO `team_member` (`id`, `team_id`, `org_membership_id`, `user_id`)
SELECT
  CONCAT('tmb_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`id`), 256), 25)),
  CONCAT('tem_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`organization_id`), 256), 25)),
  m.`id`, m.`user_id`
FROM `member` m
WHERE m.`removed_at` IS NULL AND m.`user_id` IS NOT NULL AND m.`is_setup_agent` = 0
  AND FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(m.`role`, ' ', '') AS BINARY)) > 0
  AND FIND_IN_SET(CAST('owner' AS BINARY), CAST(REPLACE(m.`role`, ' ', '') AS BINARY)) = 0
  AND NOT EXISTS (SELECT 1 FROM `permission_set` fence
    WHERE fence.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`organization_id`), 256), 25)))
  AND NOT EXISTS (SELECT 1 FROM `team_member` existing
    WHERE existing.`id` = CONCAT('tmb_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`id`), 256), 25)));
--> statement-breakpoint
-- Include a stable suffix to avoid colliding with an existing Super Admins team.
-- Never reuse a name-matched team: its members were not selected by this migration.
INSERT INTO `team` (`id`, `organization_id`, `name`, `member_count`, `grants_organization_admin`)
SELECT tm.`team_id`, m.`organization_id`,
  CONCAT('Super Admins (', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`organization_id`), 256), 8), ')'), COUNT(*), 0
FROM `team_member` tm JOIN `member` m ON m.`id` = tm.`org_membership_id`
WHERE tm.`id` = CONCAT('tmb_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`id`), 256), 25))
  AND NOT EXISTS (SELECT 1 FROM `team` existing WHERE existing.`id` = tm.`team_id`)
  AND NOT EXISTS (SELECT 1 FROM `permission_set` fence
    WHERE fence.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', m.`organization_id`), 256), 25)))
GROUP BY tm.`team_id`, m.`organization_id`;
--> statement-breakpoint
INSERT INTO `permission_set` (`id`, `organization_id`, `default_key`, `name`)
SELECT CONCAT('pms_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', t.`organization_id`), 256), 25)),
  t.`organization_id`, NULL, 'Super Admins Permissions'
FROM `team` t
WHERE t.`id` = CONCAT('tem_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', t.`organization_id`), 256), 25))
  -- Also prevents recreation after the role rewrite, even if storage was hard-deleted.
  AND EXISTS (SELECT 1 FROM `member` m WHERE m.`organization_id` = t.`organization_id`
    AND m.`removed_at` IS NULL AND m.`user_id` IS NOT NULL AND m.`is_setup_agent` = 0
    AND FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(m.`role`, ' ', '') AS BINARY)) > 0
    AND FIND_IN_SET(CAST('owner' AS BINARY), CAST(REPLACE(m.`role`, ' ', '') AS BINARY)) = 0)
  AND NOT EXISTS (SELECT 1 FROM `permission_set` existing
    WHERE existing.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', t.`organization_id`), 256), 25)));
--> statement-breakpoint
-- Exactly the 14 comparable former capabilities; not agent permissions or deployments.
-- Catalog keys live in application code, not a catalog table. 0137's history rows
-- accept these keys before the bootstrap reconciles Member/Admin default sets.
INSERT INTO `permission_set_permission` (`id`, `organization_id`, `permission_set_id`, `permission_key`, `status`, `source`)
SELECT CONCAT('psp_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', ps.`id`, ':', k.permission_key), 256), 25)),
  ps.`organization_id`, ps.`id`, k.permission_key, 'allow', 'migration'
FROM `permission_set` ps
CROSS JOIN (
  SELECT 'organization.update' AS permission_key UNION ALL SELECT 'branding.update'
  UNION ALL SELECT 'web_origins.manage' UNION ALL SELECT 'members.update'
  UNION ALL SELECT 'teams.manage_admin' UNION ALL SELECT 'permissions.manage'
  UNION ALL SELECT 'sso.manage' UNION ALL SELECT 'scim.manage'
  UNION ALL SELECT 'api_keys.manage' UNION ALL SELECT 'egress_diagnostics.manage'
  UNION ALL SELECT 'desktop_policies.manage' UNION ALL SELECT 'billing_portal.use'
  UNION ALL SELECT 'connections.update' UNION ALL SELECT 'connections.delete'
) k
WHERE ps.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', ps.`organization_id`), 256), 25))
  AND ps.`archived_at` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `permission_set_permission` existing
    WHERE existing.`permission_set_id` = ps.`id` AND existing.`permission_key` = k.permission_key);
--> statement-breakpoint
INSERT INTO `permission_set_team` (`id`, `organization_id`, `permission_set_id`, `team_id`)
SELECT CONCAT('pst_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', ps.`organization_id`), 256), 25)),
  ps.`organization_id`, ps.`id`, t.`id`
FROM `permission_set` ps JOIN `team` t ON t.`organization_id` = ps.`organization_id`
  AND t.`id` = CONCAT('tem_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', ps.`organization_id`), 256), 25))
WHERE ps.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', ps.`organization_id`), 256), 25))
  AND ps.`archived_at` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `permission_set_team` existing
    WHERE existing.`id` = CONCAT('pst_0', LEFT(SHA2(CONCAT('super-admin-preservation-0138:', ps.`organization_id`), 256), 25)));
--> statement-breakpoint
-- No team_membership_revision write here: that column is introduced by 0142,
-- after this migration. Permission grants are read per request; the new team
-- enters the revision-aware cache namespace when 0142 is applied.
-- Super-admin is deprecated and custom roles are removed (docs/permissions/overview.md, section 11).
-- Role values are comma-separated lists that may contain spaces. Each one is rewritten to the
-- built-in roles it holds, admin first as the code writes them:
--   'admin'       when it names `admin` or `super-admin`,
--   plus 'owner'  when it names `owner` (members and workspace claims; invitations never carry owner),
--   'member'      otherwise, which drops custom role names.
-- Matching is exact and case-sensitive (binary), so e.g. 'Super-Admin' is not admin. Rows already
-- in their normalized form are left alone, so running this again changes nothing.
UPDATE `member`
SET `role` = COALESCE(NULLIF(CONCAT_WS(',',
  IF(FIND_IN_SET(CAST('admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0
    OR FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'admin', NULL),
  IF(FIND_IN_SET(CAST('owner' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'owner', NULL)
), ''), 'member')
WHERE CAST(`role` AS BINARY) <> CAST(COALESCE(NULLIF(CONCAT_WS(',',
  IF(FIND_IN_SET(CAST('admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0
    OR FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'admin', NULL),
  IF(FIND_IN_SET(CAST('owner' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'owner', NULL)
), ''), 'member') AS BINARY);--> statement-breakpoint
UPDATE `invitation`
SET `role` = IF(FIND_IN_SET(CAST('admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0
  OR FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'admin', 'member')
WHERE `status` = 'pending'
  AND CAST(`role` AS BINARY) <> CAST(IF(FIND_IN_SET(CAST('admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0
    OR FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'admin', 'member') AS BINARY);--> statement-breakpoint
UPDATE `workspace_claim`
SET `role` = COALESCE(NULLIF(CONCAT_WS(',',
  IF(FIND_IN_SET(CAST('admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0
    OR FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'admin', NULL),
  IF(FIND_IN_SET(CAST('owner' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'owner', NULL)
), ''), 'member')
WHERE `status` = 'pending'
  AND CAST(`role` AS BINARY) <> CAST(COALESCE(NULLIF(CONCAT_WS(',',
    IF(FIND_IN_SET(CAST('admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0
      OR FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'admin', NULL),
    IF(FIND_IN_SET(CAST('owner' AS BINARY), CAST(REPLACE(`role`, ' ', '') AS BINARY)) > 0, 'owner', NULL)
  ), ''), 'member') AS BINARY);--> statement-breakpoint
UPDATE `desktop_policy_member` SET `role` = 'admin' WHERE `role` = 'super-admin';--> statement-breakpoint
-- Custom roles are removed and Better Auth no longer reads organization_role. The table
-- stays until a later migration drops it; the seeded super-admin rows go now.
DELETE FROM `organization_role` WHERE `role` = 'super-admin';
