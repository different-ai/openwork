import { relations, sql } from "drizzle-orm"
import { index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { accessRoleValues } from "./sharables/plugin-arch"
import { denTypeIdColumn } from "../columns"
import { MemberTable, OrganizationTable } from "./org"

export const TeamTable = mysqlTable(
  "team",
  {
    id: denTypeIdColumn("team", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("team_organization_name").on(table.organizationId, table.name),
  ],
)

export const TeamMemberTable = mysqlTable(
  "team_member",
  {
    id: denTypeIdColumn("teamMember", "id").notNull().primaryKey(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_member_org_membership_id").on(table.orgMembershipId),
    uniqueIndex("team_member_team_org_membership").on(table.teamId, table.orgMembershipId),
  ],
)

export const TeamAccessPolicyTable = mysqlTable(
  "team_access_policy",
  {
    id: denTypeIdColumn("teamAccessPolicy", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    pluginId: denTypeIdColumn("plugin", "plugin_id").notNull(),
    role: mysqlEnum("role", accessRoleValues).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [
    index("team_access_policy_organization_id").on(table.organizationId),
    index("team_access_policy_team_id").on(table.teamId),
    index("team_access_policy_plugin_id").on(table.pluginId),
    uniqueIndex("team_access_policy_team_plugin").on(table.teamId, table.pluginId),
  ],
)

export const teamRelations = relations(TeamTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [TeamTable.organizationId],
    references: [OrganizationTable.id],
  }),
  memberships: many(TeamMemberTable),
}))

export const teamMemberRelations = relations(TeamMemberTable, ({ one }) => ({
  team: one(TeamTable, {
    fields: [TeamMemberTable.teamId],
    references: [TeamTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [TeamMemberTable.orgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const team = TeamTable
export const teamMember = TeamMemberTable
