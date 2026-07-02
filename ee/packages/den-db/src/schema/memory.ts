import { index, json, mysqlEnum, mysqlTable, text, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

export const MemoryScope = ["user", "org"] as const
export const MemoryContextOrigin = ["active_conversation", "searched_conversation"] as const

// Name of the FULLTEXT index on memory.content. Drizzle mysql-core has no FULLTEXT DSL
// (drizzle-orm#1495), so this index is created out-of-band by `ensureMemoryFulltextIndex`
// (bootstrap path) and the memory migration (migrate path); both reference this name.
export const MEMORY_CONTENT_FULLTEXT_INDEX = "memory_content_fulltext"

export const MemoryTable = mysqlTable(
  "memory",
  {
    id: denTypeIdColumn("memory", "id").notNull().primaryKey(),
    user_id: denTypeIdColumn("user", "user_id").notNull(),
    org_id: denTypeIdColumn("org", "org_id").notNull(),
    scope: mysqlEnum("scope", MemoryScope).notNull().default("user"),
    content: text("content").notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    tags: json("tags"),
    ...timestamps,
  },
  (table) => [index("memory_user_id").on(table.user_id)],
)

export const MemoryContextTable = mysqlTable(
  "memory_context",
  {
    id: denTypeIdColumn("memctx", "id").notNull().primaryKey(),
    // No DB-level FK: den-db avoids FK constraints (PlanetScale/Vitess convention). The
    // memory -> memory_context cascade is enforced explicitly in the delete handler,
    // supported by this index.
    memory_id: denTypeIdColumn("memory", "memory_id").notNull(),
    citation: json("citation"),
    snippet: text("snippet").notNull(),
    origin: mysqlEnum("origin", MemoryContextOrigin),
    created_at: timestamps.created_at,
  },
  (table) => [index("memory_context_memory_id").on(table.memory_id)],
)
