import { sql } from "drizzle-orm"
import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * The friendly name of a public App's URL, `/mcp/public/apps/<name>`. A name
 * is unique across the deployment, because the URL does not say which
 * organization it belongs to, and an App has at most one. The row only maps a
 * name to its App: whether the App is public is decided by the App's current
 * revision on every request. A name stays with its App while the App is
 * private, so an old URL never starts serving another App.
 */
export const PublicMcpAppNameTable = mysqlTable(
  "public_mcp_app_name",
  {
    /** Lowercase letters, digits and hyphens. */
    name: varchar("name", { length: 64 }).notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The App (config object of type app). */
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("public_mcp_app_name_config_object_id").on(table.configObjectId),
    index("public_mcp_app_name_organization_id").on(table.organizationId),
  ],
)
