import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Exact HTTPS web origins an organization's owners have approved for web
 * sign-in handoff and Den API browser access. Kept out of organization
 * metadata so ordinary member reads never receive the list, and indexed by
 * origin so the CORS check can resolve a request origin without an org.
 */
export const OrganizationWebOriginTable = mysqlTable(
  "organization_web_origin",
  {
    id: denTypeIdColumn("organizationWebOrigin", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    origin: varchar("origin", { length: 255 }).notNull(),
    createdByOrgMemberId: denTypeIdColumn("member", "created_by_org_member_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_web_origin_org_origin").on(table.organizationId, table.origin),
    index("organization_web_origin_origin").on(table.origin),
  ],
)
