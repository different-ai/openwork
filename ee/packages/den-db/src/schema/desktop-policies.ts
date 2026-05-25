import { relations, sql } from "drizzle-orm"
import { boolean, index, json, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type { DesktopPolicyValue } from "@openwork/types/den/desktop-policies"
import { denTypeIdColumn } from "../columns"
import { MemberTable, OrganizationTable } from "./org"
import { TeamTable } from "./teams"

export const DesktopPolicyTable = mysqlTable(
  "desktop_policy",
  {
    id: denTypeIdColumn("desktopPolicy", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    policyName: varchar("policy_name", { length: 255 }).notNull(),
    isDefault: boolean("is_default"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    policy: json("policy").$type<DesktopPolicyValue>().notNull().default(sql`(json_object())`),
    createdByOrgMemberId: denTypeIdColumn("member", "created_by_org_member_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
  },
  (table) => [
    index("desktop_policy_organization_id").on(table.organizationId),
    index("desktop_policy_created_by_member_id").on(table.createdByOrgMemberId),
    index("desktop_policy_is_enabled").on(table.isEnabled),
    index("desktop_policy_deleted_at").on(table.deletedAt),
    uniqueIndex("desktop_policy_org_default").on(table.organizationId, table.isDefault),
  ],
)

export const DesktopPolicyMemberTable = mysqlTable(
  "desktop_policy_member",
  {
    id: denTypeIdColumn("desktopPolicyMember", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    desktopPolicyId: denTypeIdColumn("desktopPolicy", "desktop_policy_id").notNull(),
    orgMemberId: denTypeIdColumn("member", "org_member_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("desktop_policy_member_organization_id").on(table.organizationId),
    index("desktop_policy_member_policy_id").on(table.desktopPolicyId),
    index("desktop_policy_member_org_member_id").on(table.orgMemberId),
    index("desktop_policy_member_team_id").on(table.teamId),
    uniqueIndex("desktop_policy_member_policy_org_member").on(table.desktopPolicyId, table.orgMemberId),
    uniqueIndex("desktop_policy_member_policy_team").on(table.desktopPolicyId, table.teamId),
  ],
)

export const desktopPolicyRelations = relations(DesktopPolicyTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [DesktopPolicyTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMember: one(MemberTable, {
    fields: [DesktopPolicyTable.createdByOrgMemberId],
    references: [MemberTable.id],
  }),
  members: many(DesktopPolicyMemberTable),
}))

export const desktopPolicyMemberRelations = relations(DesktopPolicyMemberTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [DesktopPolicyMemberTable.organizationId],
    references: [OrganizationTable.id],
  }),
  desktopPolicy: one(DesktopPolicyTable, {
    fields: [DesktopPolicyMemberTable.desktopPolicyId],
    references: [DesktopPolicyTable.id],
  }),
  orgMember: one(MemberTable, {
    fields: [DesktopPolicyMemberTable.orgMemberId],
    references: [MemberTable.id],
  }),
  team: one(TeamTable, {
    fields: [DesktopPolicyMemberTable.teamId],
    references: [TeamTable.id],
  }),
}))

export const desktopPolicy = DesktopPolicyTable
export const desktopPolicyMember = DesktopPolicyMemberTable
