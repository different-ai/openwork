import { sql } from "drizzle-orm"
import { mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * The model an organization's admin picked as "Default for new chats". One
 * row per organization; no row means the organization has no default. The
 * model is stored as the provider and its catalog model id, never a member's
 * routed alias, so each member resolves it to the alias their access grants.
 */
export const OrganizationDefaultModelTable = mysqlTable("organization_default_model", {
  organizationId: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
  inferenceProviderId: denTypeIdColumn("inferenceProvider", "inference_provider_id").notNull(),
  modelId: varchar("model_id", { length: 255 }).notNull(),
  updatedByOrgMemberId: denTypeIdColumn("member", "updated_by_org_member_id").notNull(),
  updatedAt: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
})
