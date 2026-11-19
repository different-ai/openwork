import { sql } from "drizzle-orm"
import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * The model new desktop chats start with, chosen by an organization's admins
 * for everyone or for one team (packages/types/src/den/default-model.ts). An
 * organization has at most one row per scope: `scope_key` is "everyone" or the
 * team's id. No row means no organization default, or a team that uses it.
 */
export const OrgDefaultModelTable = mysqlTable(
  "org_default_model",
  {
    id: denTypeIdColumn("orgDefaultModel", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The team it applies to, or null for everyone. */
    teamId: denTypeIdColumn("team", "team_id"),
    scopeKey: varchar("scope_key", { length: 64 }).notNull(),
    /** `openwork`, an `lpr_…` organization provider or an `ipr_…` AI Gateway provider. */
    providerId: varchar("provider_id", { length: 128 }).notNull(),
    /** The model id; for the AI Gateway, the catalog model id rather than a member's alias. */
    modelId: varchar("model_id", { length: 255 }).notNull(),
    updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("org_default_model_scope").on(table.organizationId, table.scopeKey),
    index("org_default_model_team_id").on(table.teamId),
  ],
)

export const orgDefaultModel = OrgDefaultModelTable
