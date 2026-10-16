import { boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * A resume grant for one headless runner turn (feature `headlessDurableTurns`). The runner keeps the grant and
 * exchanges it at `POST /v1/headless/resume-token` for a fresh member-scoped MCP token for that turn, its background
 * tasks (`<messageId>.tN`) and their reports, so the turn can continue after a restart without its caller re-sending
 * it. Den keeps only the SHA-256 hash of the grant. Rows are revoked when the member leaves the organization or the
 * user is deleted, and expired rows are pruned when a new grant is minted.
 */
export const HeadlessResumeGrantTable = mysqlTable(
  "headless_resume_grant",
  {
    id: denTypeIdColumn("headlessResumeGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    /** The runner session the turn belongs to. */
    sessionId: varchar("session_id", { length: 128 }).notNull(),
    /** The turn's messageId; tasks and reports it starts extend it with `.`. */
    messageId: varchar("message_id", { length: 128 }).notNull(),
    /** Tokens exchanged for this grant can only read, like the token minted with it. */
    readOnly: boolean("read_only").notNull().default(false),
    /** SHA-256 (hex) of the grant; the grant itself is never stored. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    revokedAt: timestamp("revoked_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { fsp: 3 }),
    useCount: int("use_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("headless_resume_grant_token_hash").on(table.tokenHash),
    index("headless_resume_grant_member").on(table.userId, table.organizationId),
    index("headless_resume_grant_expires_at").on(table.expiresAt),
  ],
)
