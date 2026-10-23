-- Restore full admin rights after the Permissions release (0137/0138).
-- 0138 folded every super-admin into admin, and the Admin permission set was seeded without
-- the former super-admin actions (members.update, sso.manage, permissions.manage, ...), so
-- people who used to be full admins lost them. This gives every organization's Admin
-- permission set an allow row for every permission in the catalog as of this release, so
-- every admin (direct or through an Admin team) can again do everything the owner can except
-- delete the organization or transfer ownership, which are not permissions.
-- Owners hold every permission already; the Member set and team sets are not touched.
--
-- Organizations whose default sets were never created get them here (Member empty, as the
-- seed creates it today; Admin with every permission), so they don't fall back to the
-- narrower seed later.
--
-- A permission an owner or admin deliberately denied (latest row deny with source 'user') is
-- left denied: that is the organization's explicit decision, and it can be allowed again in
-- Settings > Permissions. Only permissions missing because of the release are restored.
--
-- Rows are appended (the table is append-only) with source 'migration', a created_at after the
-- set's latest row, and TypeID ids (UUIDv7 layout, Crockford base32) built in SQL.
-- Keys already allowed or deliberately denied are skipped, so running this again inserts nothing.
INSERT INTO `permission_set` (`id`, `organization_id`, `default_key`, `name`, `created_at`)
SELECT CONCAT('pms_', CONCAT(
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 1, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 6, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 11, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 16, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 21, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 26, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 31, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 36, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 41, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 46, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 51, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 56, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 61, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 66, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 71, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 76, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 81, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 86, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 91, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 96, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 101, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 106, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 111, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 116, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 121, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 126, 5), 2, 10) + 1, 1)
    )), b.`organization_id`, 'member', 'Member permissions', b.`created_at`
FROM (
  SELECT h.`organization_id`, h.`created_at`, CONCAT('00', LPAD(CONV(SUBSTRING(h.`hex`, 1, 16), 16, 2), 64, '0'), LPAD(CONV(SUBSTRING(h.`hex`, 17, 16), 16, 2), 64, '0')) AS `bits`
  FROM (
    SELECT r.`organization_id`, r.`created_at`, CONCAT(LPAD(HEX(FLOOR(UNIX_TIMESTAMP(r.`created_at`) * 1000)), 12, '0'), '7', SUBSTRING(r.`seed`, 1, 3), ELT(1 + (CONV(SUBSTRING(r.`seed`, 4, 1), 16, 10) & 3), '8', '9', 'a', 'b'), SUBSTRING(r.`seed`, 5, 15)) AS `hex`
    FROM (
      SELECT o.`id` AS `organization_id`, NOW(3) AS `created_at`, MD5(CONCAT(o.`id`, 'member', UUID())) AS `seed`
      FROM `organization` o
      WHERE NOT EXISTS (
        SELECT 1 FROM `permission_set` s WHERE s.`organization_id` = o.`id` AND s.`default_key` = 'member'
      )
    ) r
  ) h
) b;--> statement-breakpoint
INSERT INTO `permission_set` (`id`, `organization_id`, `default_key`, `name`, `created_at`)
SELECT CONCAT('pms_', CONCAT(
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 1, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 6, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 11, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 16, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 21, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 26, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 31, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 36, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 41, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 46, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 51, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 56, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 61, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 66, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 71, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 76, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 81, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 86, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 91, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 96, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 101, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 106, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 111, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 116, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 121, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 126, 5), 2, 10) + 1, 1)
    )), b.`organization_id`, 'admin', 'Admin permissions', b.`created_at`
FROM (
  SELECT h.`organization_id`, h.`created_at`, CONCAT('00', LPAD(CONV(SUBSTRING(h.`hex`, 1, 16), 16, 2), 64, '0'), LPAD(CONV(SUBSTRING(h.`hex`, 17, 16), 16, 2), 64, '0')) AS `bits`
  FROM (
    SELECT r.`organization_id`, r.`created_at`, CONCAT(LPAD(HEX(FLOOR(UNIX_TIMESTAMP(r.`created_at`) * 1000)), 12, '0'), '7', SUBSTRING(r.`seed`, 1, 3), ELT(1 + (CONV(SUBSTRING(r.`seed`, 4, 1), 16, 10) & 3), '8', '9', 'a', 'b'), SUBSTRING(r.`seed`, 5, 15)) AS `hex`
    FROM (
      SELECT o.`id` AS `organization_id`, NOW(3) AS `created_at`, MD5(CONCAT(o.`id`, 'admin', UUID())) AS `seed`
      FROM `organization` o
      WHERE NOT EXISTS (
        SELECT 1 FROM `permission_set` s WHERE s.`organization_id` = o.`id` AND s.`default_key` = 'admin'
      )
    ) r
  ) h
) b;--> statement-breakpoint
INSERT INTO `permission_set_permission` (`id`, `organization_id`, `permission_set_id`, `permission_key`, `status`, `source`, `changed_by_org_membership_id`, `created_at`)
SELECT CONCAT('psp_', CONCAT(
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 1, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 6, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 11, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 16, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 21, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 26, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 31, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 36, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 41, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 46, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 51, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 56, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 61, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 66, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 71, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 76, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 81, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 86, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 91, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 96, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 101, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 106, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 111, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 116, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 121, 5), 2, 10) + 1, 1),
      SUBSTRING('0123456789abcdefghjkmnpqrstvwxyz', CONV(SUBSTRING(b.`bits`, 126, 5), 2, 10) + 1, 1)
    )), b.`organization_id`, b.`permission_set_id`, b.`permission_key`, 'allow', 'migration', NULL, b.`created_at`
FROM (
  SELECT h.`organization_id`, h.`permission_set_id`, h.`permission_key`, h.`created_at`, CONCAT('00', LPAD(CONV(SUBSTRING(h.`hex`, 1, 16), 16, 2), 64, '0'), LPAD(CONV(SUBSTRING(h.`hex`, 17, 16), 16, 2), 64, '0')) AS `bits`
  FROM (
    SELECT r.`organization_id`, r.`permission_set_id`, r.`permission_key`, r.`created_at`, CONCAT(LPAD(HEX(FLOOR(UNIX_TIMESTAMP(r.`created_at`) * 1000)), 12, '0'), '7', SUBSTRING(r.`seed`, 1, 3), ELT(1 + (CONV(SUBSTRING(r.`seed`, 4, 1), 16, 10) & 3), '8', '9', 'a', 'b'), SUBSTRING(r.`seed`, 5, 15)) AS `hex`
    FROM (
      SELECT s.`organization_id`, s.`id` AS `permission_set_id`, k.`permission_key`,
        GREATEST(NOW(3), COALESCE(
          (SELECT MAX(l.`created_at`) FROM `permission_set_permission` l WHERE l.`permission_set_id` = s.`id`) + INTERVAL 1000 MICROSECOND,
          NOW(3)
        )) AS `created_at`,
        MD5(CONCAT(s.`id`, k.`permission_key`, UUID())) AS `seed`
      FROM `permission_set` s
      CROSS JOIN (
        SELECT 'organization.update' AS `permission_key`
        UNION ALL SELECT 'branding.update'
        UNION ALL SELECT 'web_origins.view'
        UNION ALL SELECT 'web_origins.manage'
        UNION ALL SELECT 'invitations.manage'
        UNION ALL SELECT 'members.update'
        UNION ALL SELECT 'members.delete'
        UNION ALL SELECT 'teams.view'
        UNION ALL SELECT 'teams.manage'
        UNION ALL SELECT 'teams.manage_admin'
        UNION ALL SELECT 'permissions.view'
        UNION ALL SELECT 'permissions.manage'
        UNION ALL SELECT 'agent_permissions.view'
        UNION ALL SELECT 'agent_permissions.manage'
        UNION ALL SELECT 'sharing.manage_all'
        UNION ALL SELECT 'sharing.share_org_wide'
        UNION ALL SELECT 'sso.view'
        UNION ALL SELECT 'sso.manage'
        UNION ALL SELECT 'scim.view'
        UNION ALL SELECT 'scim.manage'
        UNION ALL SELECT 'api_keys.view'
        UNION ALL SELECT 'api_keys.manage'
        UNION ALL SELECT 'audit.view'
        UNION ALL SELECT 'audit.manage'
        UNION ALL SELECT 'egress_diagnostics.view'
        UNION ALL SELECT 'egress_diagnostics.manage'
        UNION ALL SELECT 'desktop_policies.view'
        UNION ALL SELECT 'desktop_policies.manage'
        UNION ALL SELECT 'deployments.view'
        UNION ALL SELECT 'deployments.manage'
        UNION ALL SELECT 'billing.view'
        UNION ALL SELECT 'billing.manage'
        UNION ALL SELECT 'billing_portal.use'
        UNION ALL SELECT 'inference.view'
        UNION ALL SELECT 'inference.manage'
        UNION ALL SELECT 'usage_analytics.view'
        UNION ALL SELECT 'analytics.view'
        UNION ALL SELECT 'analytics.manage'
        UNION ALL SELECT 'llm_providers.view'
        UNION ALL SELECT 'llm_providers.update'
        UNION ALL SELECT 'llm_providers.delete'
        UNION ALL SELECT 'llm_provider_credentials.manage'
        UNION ALL SELECT 'gateway_providers.view'
        UNION ALL SELECT 'gateway_providers.manage'
        UNION ALL SELECT 'gateway_usage.view'
        UNION ALL SELECT 'gateway_limits.view'
        UNION ALL SELECT 'gateway_limits.manage'
        UNION ALL SELECT 'connections.view'
        UNION ALL SELECT 'connections.manage'
        UNION ALL SELECT 'connections.update'
        UNION ALL SELECT 'connections.disconnect'
        UNION ALL SELECT 'connections.delete'
        UNION ALL SELECT 'oauth_clients.view'
        UNION ALL SELECT 'oauth_clients.manage'
        UNION ALL SELECT 'marketplaces.manage'
        UNION ALL SELECT 'plugins.import'
        UNION ALL SELECT 'connectors.manage'
      ) k
      WHERE s.`default_key` = 'admin'
        -- Skip keys whose current state (latest row by created_at, then id) is already allow,
        -- or a deny a person chose.
        AND NOT EXISTS (
          SELECT 1 FROM `permission_set_permission` p
          WHERE p.`permission_set_id` = s.`id`
            AND CAST(p.`permission_key` AS BINARY) = CAST(k.`permission_key` AS BINARY)
            AND (p.`status` = 'allow' OR (p.`status` = 'deny' AND p.`source` = 'user'))
            AND NOT EXISTS (
              SELECT 1 FROM `permission_set_permission` q
              WHERE q.`permission_set_id` = p.`permission_set_id`
                AND CAST(q.`permission_key` AS BINARY) = CAST(p.`permission_key` AS BINARY)
                AND (q.`created_at` > p.`created_at` OR (q.`created_at` = p.`created_at` AND CAST(q.`id` AS BINARY) > CAST(p.`id` AS BINARY)))
            )
        )
    ) r
  ) h
) b;
