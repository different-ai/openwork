import { sql } from "drizzle-orm"
import { bigint, index, int, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * One row per artifact that has a database of saved data. The data itself is
 * in the storage backend named here, never in this table: the row records
 * that a database exists, so it can be listed for admins and removed when the
 * artifact or its organization is deleted, and how large it was after its
 * last write, for admins. `backend` is pinned by the first write: a database
 * is only ever used through the backend that created it. `deletedAt` is set
 * before a database is removed and the row goes only once the backend has
 * confirmed, so a failed removal is retried and never forgotten.
 */
export const McpAppStorageTable = mysqlTable(
  "mcp_app_storage",
  {
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    backend: varchar("backend", { length: 32 }).notNull(),
    rowCount: int("row_count").notNull().default(0),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("mcp_app_storage_organization_id").on(table.organizationId),
  ],
)
