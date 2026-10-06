import { sql } from "drizzle-orm"
import { index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../../columns"

// Retired (W0-P13 PR B, D36). Nothing reads or writes this table any more.
// The file is not exported from the schema barrel, only listed in
// drizzle.config.ts so db:generate keeps the table until the follow-up drop
// (W0-P13 PR G, one release later). Do not import it from runtime code.
export const remoteMcpAppStatusValues = ["active", "retired"] as const

/**
 * Mutable installation state for a portable MCP App. The actual app bytes and
 * manifest live in immutable ConfigObjectVersion rows; this table only points
 * at the explicitly selected revision and remembers the import source.
 */
export const RemoteMcpAppTable = mysqlTable(
  "remote_mcp_app",
  {
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    pluginId: denTypeIdColumn("plugin", "plugin_id").notNull(),
    activeVersionId: denTypeIdColumn("configObjectVersion", "active_version_id"),
    sourceUrl: varchar("source_url", { length: 2048 }).notNull(),
    resolvedSourceUrl: varchar("resolved_source_url", { length: 2048 }).notNull(),
    status: mysqlEnum("status", remoteMcpAppStatusValues).notNull().default("active"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    retiredAt: timestamp("retired_at", { fsp: 3 }),
  },
  (table) => [
    index("remote_mcp_app_organization_id").on(table.organizationId),
    uniqueIndex("remote_mcp_app_plugin_id").on(table.pluginId),
    index("remote_mcp_app_active_version_id").on(table.activeVersionId),
    index("remote_mcp_app_status").on(table.status),
  ],
)
