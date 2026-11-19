import { sql } from "drizzle-orm"
import { boolean, index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

/**
 * A system prompt an organization's admins write to steer the work agents do
 * on members' desktops (packages/types/src/den/prompts.ts). Desktops append
 * every prompt assigned to a member to OpenWork's own instructions.
 */
export const OrgPromptTable = mysqlTable(
  "org_prompt",
  {
    id: denTypeIdColumn("orgPrompt", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    /** Encrypted at rest, like config objects' source text. */
    content: encryptedMediumTextColumn("content").notNull(),
    createdByOrgMemberId: denTypeIdColumn("member", "created_by_org_member_id"),
    updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("org_prompt_organization_id").on(table.organizationId)],
)

/**
 * Who a prompt applies to, following the assignment pattern of other
 * organization items: everyone (`org_wide`), one member, or one team per row.
 */
export const OrgPromptAccessTable = mysqlTable(
  "org_prompt_access",
  {
    id: denTypeIdColumn("orgPromptAccess", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    promptId: denTypeIdColumn("orgPrompt", "prompt_id").notNull(),
    orgWide: boolean("org_wide").notNull().default(false),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("org_prompt_access_organization_id").on(table.organizationId),
    index("org_prompt_access_org_membership_id").on(table.orgMembershipId),
    index("org_prompt_access_team_id").on(table.teamId),
    uniqueIndex("org_prompt_access_prompt_member").on(table.promptId, table.orgMembershipId),
    uniqueIndex("org_prompt_access_prompt_team").on(table.promptId, table.teamId),
  ],
)

export const orgPrompt = OrgPromptTable
export const orgPromptAccess = OrgPromptAccessTable
