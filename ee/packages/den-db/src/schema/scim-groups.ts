import { boolean, index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

export const ScimGroupTable = mysqlTable(
  "scim_group",
  {
    id: denTypeIdColumn("scimGroup", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    scimGroupId: varchar("scim_group_id", { length: 64 }).notNull(),
    externalId: varchar("external_id", { length: 191 }),
    externalIdKey: varchar("external_id_key", { length: 768 }),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    teamId: denTypeIdColumn("team", "team_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_scim_group_id").on(table.scimGroupId),
    uniqueIndex("scim_group_provider_external_id").on(table.providerId, table.externalId),
    uniqueIndex("scim_group_external_id_key").on(table.externalIdKey),
    uniqueIndex("scim_group_team_id").on(table.teamId),
    index("scim_group_organization_id").on(table.organizationId),
  ],
)

export const ScimGroupMemberTable = mysqlTable(
  "scim_group_member",
  {
    id: denTypeIdColumn("scimGroupMember", "id").notNull().primaryKey(),
    groupId: denTypeIdColumn("scimGroup", "group_id").notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id"),
    providerId: varchar("provider_id", { length: 255 }),
    remoteUserId: varchar("remote_user_id", { length: 191 }),
    membershipKey: varchar("membership_key", { length: 768 }),
    userId: denTypeIdColumn("user", "user_id"),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamMemberId: denTypeIdColumn("teamMember", "team_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_member_group_remote_user").on(table.groupId, table.remoteUserId),
    uniqueIndex("scim_group_member_membership_key").on(table.membershipKey),
    index("scim_group_member_user_id").on(table.userId),
    index("scim_group_member_org_membership_id").on(table.orgMembershipId),
    index("scim_group_member_team_member_id").on(table.teamMemberId),
    index("scim_group_member_provider_org").on(table.providerId, table.organizationId),
  ],
)

export const ScimGroupRoleTable = mysqlTable(
  "scim_group_role",
  {
    id: denTypeIdColumn("scimGroupRole", "id").notNull().primaryKey(),
    groupId: denTypeIdColumn("scimGroup", "group_id").notNull(),
    role: varchar("role", { length: 255 }).notNull(),
    roleKey: varchar("role_key", { length: 768 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("scim_group_role_role_key").on(table.roleKey), index("scim_group_role_group_id").on(table.groupId)],
)

export const ScimGroupRoleGrantTable = mysqlTable(
  "scim_group_role_grant",
  {
    id: denTypeIdColumn("scimGroupRoleGrant", "id").notNull().primaryKey(),
    groupId: denTypeIdColumn("scimGroup", "group_id").notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    role: varchar("role", { length: 255 }).notNull(),
    roleGrantKey: varchar("role_grant_key", { length: 768 }).notNull(),
    isRoleProjected: boolean("is_role_projected").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_role_grant_role_grant_key").on(table.roleGrantKey),
    index("scim_group_role_grant_group_id").on(table.groupId),
    index("scim_group_role_grant_provider_org").on(table.providerId, table.organizationId),
    index("scim_group_role_grant_user_id").on(table.userId),
  ],
)

export const ScimUserTombstoneTable = mysqlTable(
  "scim_user_tombstone",
  {
    id: denTypeIdColumn("scimUserTombstone", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    deprovisionedUserId: denTypeIdColumn("user", "deprovisioned_user_id"),
    externalId: varchar("external_id", { length: 191 }),
    email: varchar("email", { length: 191 }),
    deprovisionedAt: timestamp("deprovisioned_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_user_tombstone_org_user").on(table.organizationId, table.deprovisionedUserId),
    index("scim_user_tombstone_org_external_id").on(table.organizationId, table.externalId),
    index("scim_user_tombstone_org_email").on(table.organizationId, table.email),
  ],
)

export const scimGroup = ScimGroupTable
export const scimGroupMember = ScimGroupMemberTable
export const scimGroupRole = ScimGroupRoleTable
export const scimGroupRoleGrant = ScimGroupRoleGrantTable
