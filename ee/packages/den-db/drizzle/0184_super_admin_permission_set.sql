-- Super admin default permission set: permission_set.default_key gains
-- 'super-admin' beside 'member' and 'admin'. Appending an enum value is an
-- in-place, metadata-only change in MySQL and on PlanetScale, and existing
-- rows keep their values. No rows are written here: each organization's Super
-- admin set is created (seeded with every catalog permission) on first use by
-- ensureDefaultPermissionSets, as Member and Admin are.
ALTER TABLE `permission_set` MODIFY COLUMN `default_key` enum('member','admin','super-admin');
