import { relations, sql } from "drizzle-orm"
import { index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"
import { MemberTable, OrganizationTable } from "./org"

export const TeamTable = mysqlTable(
  "team",
  {
    externalKey: varchar("external_key", { length: 128 }),
    id: denTypeIdColumn("team", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    memberCount: int("member_count").notNull().default(0),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("team_org_external_key").on(table.organizationId, table.externalKey),
    uniqueIndex("team_organization_name").on(table.organizationId, table.name),
  ],
)

export const TeamMemberTable = mysqlTable(
  "team_member",
  {
    id: denTypeIdColumn("teamMember", "id").notNull().primaryKey(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    userId: denTypeIdColumn("user", "user_id"),
    membershipKey: varchar("membership_key", { length: 64 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_member_org_membership_id").on(table.orgMembershipId),
    index("team_member_user_id").on(table.userId),
    uniqueIndex("team_member_membership_key").on(table.membershipKey),
    uniqueIndex("team_member_team_org_membership").on(table.teamId, table.orgMembershipId),
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
