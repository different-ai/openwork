import { sql } from "drizzle-orm"
import { mysqlTable, timestamp } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../columns"

/**
 * One encrypted, organization-owned credential for the fixed egress
 * diagnostic. The bearer value is deliberately kept out of organization
 * metadata so ordinary organization reads can never expose it.
 */
export const OrganizationDiagnosticCredentialTable = mysqlTable(
  "organization_diagnostic_credential",
  {
    organizationId: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
    bearerToken: encryptedTextColumn("bearer_token").notNull(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
)
