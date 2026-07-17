import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

export const ScimGroupTable = mysqlTable(
  "scim_group",
  {
    id: denTypeIdColumn("scimGroup", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    externalId: varchar("external_id", { length: 191 }),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    teamId: denTypeIdColumn("team", "team_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_provider_external_id").on(table.providerId, table.externalId),
    uniqueIndex("scim_group_team_id").on(table.teamId),
    index("scim_group_organization_id").on(table.organizationId),
    index("scim_group_provider_id").on(table.providerId),
  ],
)

export const ScimGroupMemberTable = mysqlTable(
  "scim_group_member",
  {
    id: denTypeIdColumn("scimGroupMember", "id").notNull().primaryKey(),
    groupId: denTypeIdColumn("scimGroup", "group_id").notNull(),
    remoteUserId: varchar("remote_user_id", { length: 191 }).notNull(),
    userId: denTypeIdColumn("user", "user_id"),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamMemberId: denTypeIdColumn("teamMember", "team_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_member_group_remote_user").on(table.groupId, table.remoteUserId),
    index("scim_group_member_user_id").on(table.userId),
    index("scim_group_member_org_membership_id").on(table.orgMembershipId),
    index("scim_group_member_team_member_id").on(table.teamMemberId),
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
