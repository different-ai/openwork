import { sql } from "drizzle-orm"
import { index, json, mysqlTable, timestamp, uniqueIndex } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * One team's own Workbot settings, chosen by an organization's admins
 * (packages/types/src/den/workbot-team-settings.ts). A team has at most one
 * row. No row means the team uses the organization's settings.
 */
export const WorkbotTeamSettingTable = mysqlTable(
  "workbot_team_setting",
  {
    id: denTypeIdColumn("workbotTeamSetting", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    teamId: denTypeIdColumn("team", "team_id").notNull(),
    /** A key that is absent means the team uses the organization's value; a key that is present is the team's own. */
    settings: json("settings").$type<Record<string, unknown>>().notNull(),
    updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("workbot_team_setting_team").on(table.organizationId, table.teamId),
    index("workbot_team_setting_team_id").on(table.teamId),
  ],
)

export const workbotTeamSetting = WorkbotTeamSettingTable
