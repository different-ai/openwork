import { relations, sql } from "drizzle-orm"
import { index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"
import { MemberTable, OrganizationTable } from "./org"
import { TeamTable } from "./teams"

// Database order: values are only ever appended (an in-place, metadata-only change in MySQL).
export const permissionSetDefaultKeyValues = ["member", "admin", "super-admin", "billing-manager"] as const
export type PermissionSetDefaultKey = (typeof permissionSetDefaultKeyValues)[number]

export const permissionStatusValues = ["allow", "deny"] as const
export type PermissionStatus = (typeof permissionStatusValues)[number]

export const permissionChangeSourceValues = ["user", "seed", "reconcile", "migration"] as const
export type PermissionChangeSource = (typeof permissionChangeSourceValues)[number]

/**
 * A named bundle of permissions. `defaultKey` marks the organization's
 * built-in sets (Member, Admin, Super admin, Billing manager); NULL means a
 * custom role. MySQL allows many NULLs in
 * the unique index, so an org has at most one set per default key and any
 * number of team sets. Sets are archived, never deleted.
 */
export const PermissionSetTable = mysqlTable(
  "permission_set",
  {
    id: denTypeIdColumn("permissionSet", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    defaultKey: mysqlEnum("default_key", permissionSetDefaultKeyValues),
    name: varchar("name", { length: 255 }).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    archivedAt: timestamp("archived_at", { fsp: 3 }),
    archivedByOrgMembershipId: denTypeIdColumn("member", "archived_by_org_membership_id"),
  },
  (table) => [
    index("permission_set_organization_id").on(table.organizationId),
    uniqueIndex("permission_set_org_default_key").on(table.organizationId, table.defaultKey),
  ],
)

/**
 * Append-only permission history. Rows are never updated or deleted; the
 * latest row by (created_at, id) for a set and key is its current state, and
 * no row means denied.
 */
export const PermissionSetPermissionTable = mysqlTable(
  "permission_set_permission",
  {
    id: denTypeIdColumn("permissionSetPermission", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    permissionSetId: denTypeIdColumn("permissionSet", "permission_set_id").notNull(),
    permissionKey: varchar("permission_key", { length: 128 }).notNull(),
    status: mysqlEnum("status", permissionStatusValues).notNull(),
    source: mysqlEnum("source", permissionChangeSourceValues).notNull(),
    changedByOrgMembershipId: denTypeIdColumn("member", "changed_by_org_membership_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("permission_set_permission_set_key_created").on(
      table.permissionSetId,
      table.permissionKey,
      table.createdAt,
      table.id,
    ),
    index("permission_set_permission_organization_id").on(table.organizationId),
  ],
)

/**
 * Links a permission set to a team. Soft-removed like plugin_access_grant:
 * re-linking the same pair clears `removedAt` on the existing row.
 */
export const PermissionSetTeamTable = mysqlTable(
  "permission_set_team",
  {
    id: denTypeIdColumn("permissionSetTeam", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    permissionSetId: denTypeIdColumn("permissionSet", "permission_set_id").notNull(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
    removedByOrgMembershipId: denTypeIdColumn("member", "removed_by_org_membership_id"),
  },
  (table) => [
    index("permission_set_team_organization_id").on(table.organizationId),
    index("permission_set_team_team_id").on(table.teamId),
    uniqueIndex("permission_set_team_set_team").on(table.permissionSetId, table.teamId),
  ],
)

/**
 * Gives a permission set to one person directly, without a team. Soft-removed
 * like permission_set_team: giving the same person the same set again clears
 * `removedAt` on the existing row. A person holds at most one set this way;
 * the API replaces the previous one.
 */
export const PermissionSetMemberTable = mysqlTable(
  "permission_set_member",
  {
    id: denTypeIdColumn("permissionSetMember", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    permissionSetId: denTypeIdColumn("permissionSet", "permission_set_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
    removedByOrgMembershipId: denTypeIdColumn("member", "removed_by_org_membership_id"),
  },
  (table) => [
    index("permission_set_member_organization_id").on(table.organizationId),
    index("permission_set_member_org_membership_id").on(table.orgMembershipId),
    uniqueIndex("permission_set_member_set_member").on(table.permissionSetId, table.orgMembershipId),
  ],
)

export const permissionSetRelations = relations(PermissionSetTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [PermissionSetTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [PermissionSetTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  permissions: many(PermissionSetPermissionTable),
  teams: many(PermissionSetTeamTable),
  members: many(PermissionSetMemberTable),
}))

export const permissionSetPermissionRelations = relations(PermissionSetPermissionTable, ({ one }) => ({
  permissionSet: one(PermissionSetTable, {
    fields: [PermissionSetPermissionTable.permissionSetId],
    references: [PermissionSetTable.id],
  }),
  changedByOrgMembership: one(MemberTable, {
    fields: [PermissionSetPermissionTable.changedByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const permissionSetTeamRelations = relations(PermissionSetTeamTable, ({ one }) => ({
  permissionSet: one(PermissionSetTable, {
    fields: [PermissionSetTeamTable.permissionSetId],
    references: [PermissionSetTable.id],
  }),
  team: one(TeamTable, {
    fields: [PermissionSetTeamTable.teamId],
    references: [TeamTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [PermissionSetTeamTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const permissionSetMemberRelations = relations(PermissionSetMemberTable, ({ one }) => ({
  permissionSet: one(PermissionSetTable, {
    fields: [PermissionSetMemberTable.permissionSetId],
    references: [PermissionSetTable.id],
  }),
  member: one(MemberTable, {
    fields: [PermissionSetMemberTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [PermissionSetMemberTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))
