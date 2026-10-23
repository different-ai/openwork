import { relations, sql } from "drizzle-orm"
import {
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../../columns"
import { MemberTable, OrganizationTable } from "../org"
import { TeamTable } from "../teams"

/**
 * How an environment variable gets its value:
 * - `admin`: an admin sets the value on each assignment (everyone, a team or
 *   one person).
 * - `per_member`: each person who receives it sets their own value.
 */
export const environmentVariableValueModes = ["admin", "per_member"] as const

/**
 * An organization environment variable delivered to members' desktop agents
 * (the OpenCode process environment). Values are encrypted at rest and only
 * returned to the desktop that runs the agent, never listed in the UI.
 */
export const EnvironmentVariableTable = mysqlTable(
  "environment_variable",
  {
    id: denTypeIdColumn("environmentVariable", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    key: varchar("env_key", { length: 255 }).notNull(),
    description: text("description"),
    valueMode: mysqlEnum("value_mode", environmentVariableValueModes).notNull().default("admin"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("environment_variable_org_key").on(table.organizationId, table.key),
    index("environment_variable_created_by").on(table.createdByOrgMembershipId),
  ],
)

/**
 * One assignment: who receives the variable, and (admin mode) the value they
 * get from it. A row names one member or one team; a row with both empty
 * means everyone in the organization.
 */
export const EnvironmentVariableAccessTable = mysqlTable(
  "environment_variable_access",
  {
    id: denTypeIdColumn("environmentVariableAccess", "id").notNull().primaryKey(),
    environmentVariableId: denTypeIdColumn("environmentVariable", "environment_variable_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    value: encryptedTextColumn("value"),
    updatedByOrgMembershipId: denTypeIdColumn("member", "updated_by_org_membership_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("environment_variable_access_org_membership_id").on(table.orgMembershipId),
    index("environment_variable_access_team_id").on(table.teamId),
    uniqueIndex("environment_variable_access_variable_member").on(
      table.environmentVariableId,
      table.orgMembershipId,
    ),
    uniqueIndex("environment_variable_access_variable_team").on(
      table.environmentVariableId,
      table.teamId,
    ),
  ],
)

/**
 * One person's own settings for a variable: their value (per_member) or the
 * assignment they chose when several give them a value (admin mode).
 */
export const EnvironmentVariableMemberSettingTable = mysqlTable(
  "environment_variable_member_setting",
  {
    id: denTypeIdColumn("environmentVariableMemberSetting", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    environmentVariableId: denTypeIdColumn("environmentVariable", "environment_variable_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    value: encryptedTextColumn("value"),
    selectedAccessId: denTypeIdColumn("environmentVariableAccess", "selected_access_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("environment_variable_member_setting_organization_id").on(table.organizationId),
    index("environment_variable_member_setting_org_membership_id").on(table.orgMembershipId),
    uniqueIndex("environment_variable_member_setting_variable_member").on(
      table.environmentVariableId,
      table.orgMembershipId,
    ),
  ],
)

export const environmentVariableRelations = relations(EnvironmentVariableTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [EnvironmentVariableTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [EnvironmentVariableTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  accessLinks: many(EnvironmentVariableAccessTable),
  memberSettings: many(EnvironmentVariableMemberSettingTable),
}))

export const environmentVariableAccessRelations = relations(EnvironmentVariableAccessTable, ({ one }) => ({
  environmentVariable: one(EnvironmentVariableTable, {
    fields: [EnvironmentVariableAccessTable.environmentVariableId],
    references: [EnvironmentVariableTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [EnvironmentVariableAccessTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  team: one(TeamTable, {
    fields: [EnvironmentVariableAccessTable.teamId],
    references: [TeamTable.id],
  }),
}))

export const environmentVariableMemberSettingRelations = relations(EnvironmentVariableMemberSettingTable, ({ one }) => ({
  environmentVariable: one(EnvironmentVariableTable, {
    fields: [EnvironmentVariableMemberSettingTable.environmentVariableId],
    references: [EnvironmentVariableTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [EnvironmentVariableMemberSettingTable.orgMembershipId],
    references: [MemberTable.id],
  }),
}))
