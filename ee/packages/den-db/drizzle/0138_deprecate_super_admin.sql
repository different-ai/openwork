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
