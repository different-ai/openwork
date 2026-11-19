import { index, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core"

/**
 * Ledger for lifecycle reminder emails (for example "claim your workspace" or
 * "bring your team"). The (kind, subject_key) primary key makes each reminder
 * at-most-once across every Den API replica: a sweep inserts the row first and
 * only the insert that wins sends. The same table records unsubscribes as
 * kind = "unsubscribe" keyed by the lowercased email address.
 */
export const LifecycleEmailTable = mysqlTable(
  "lifecycle_email",
  {
    kind: varchar("kind", { length: 64 }).notNull(),
    subjectKey: varchar("subject_key", { length: 255 }).notNull(),
    recipient: varchar("recipient", { length: 255 }).notNull(),
    // sending -> sent | failed; unsubscribe rows are written as "recorded".
    status: varchar("status", { length: 32 }).notNull().default("sending"),
    error: varchar("error", { length: 255 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { fsp: 3 }),
  },
  (table) => [
    primaryKey({ name: "lifecycle_email_kind_subject", columns: [table.kind, table.subjectKey] }),
    index("lifecycle_email_recipient").on(table.recipient),
  ],
)
