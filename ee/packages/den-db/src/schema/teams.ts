import { sql } from "drizzle-orm"
import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

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
    index("team_organization_id").on(table.organizationId),
    uniqueIndex("team_organization_name").on(table.organizationId, table.name),
  ],
)

export const TeamMemberTable = mysqlTable(
  "team_member",
  {
    id: denTypeIdColumn("teamMember", "id").notNull().primaryKey(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("team_member_team_id").on(table.teamId),
    index("team_member_user_id").on(table.userId),
    uniqueIndex("team_member_team_user").on(table.teamId, table.userId),
  ],
)

export const team = TeamTable
export const teamMember = TeamMemberTable
