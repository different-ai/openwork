import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../../columns"

export type CachedExternalMcpTool = {
  name: string
  title?: string
  description?: string
}

export const externalMcpToolManifestStatusValues = ["ok", "error"] as const
export type ExternalMcpToolManifestStatus = (typeof externalMcpToolManifestStatusValues)[number]

export const ExternalMcpToolManifestTable = mysqlTable(
  "external_mcp_tool_manifest",
  {
    id: denTypeIdColumn("externalMcpToolManifest", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    externalMcpConnectionId: denTypeIdColumn(
      "externalMcpConnection",
      "external_mcp_connection_id",
    ).notNull(),
    principal: varchar("principal", { length: 64 }).notNull(),
    configHash: varchar("config_hash", { length: 64 }).notNull(),
    status: mysqlEnum("status", externalMcpToolManifestStatusValues).notNull(),
    tools: json("tools").$type<CachedExternalMcpTool[]>().notNull(),
    toolCount: int("tool_count").notNull().default(0),
    toolsHash: varchar("tools_hash", { length: 64 }),
    toolsTruncated: boolean("tools_truncated").notNull().default(false),
    lastError: text("last_error"),
    durationMs: int("duration_ms"),
    listedAt: timestamp("listed_at", { fsp: 3 }),
    staleAt: timestamp("stale_at", { fsp: 3 }),
    refreshStartedAt: timestamp("refresh_started_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("emtm_connection_principal").on(table.externalMcpConnectionId, table.principal),
    index("emtm_organization_id").on(table.organizationId),
    index("emtm_listed_at").on(table.listedAt),
    index("emtm_refresh_started_at").on(table.refreshStartedAt),
  ],
)
