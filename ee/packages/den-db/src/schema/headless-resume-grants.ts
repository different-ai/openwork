import { boolean, index, int, mysqlTable, primaryKey, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn } from "../columns"

/**
 * A resume grant for one headless runner turn (saved step turns). The runner keeps the grant and
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
    sessionId: varchar("session_id", { length: 128 }).notNull(),
    messageId: varchar("message_id", { length: 128 }).notNull(),
    readOnly: boolean("read_only").notNull().default(false),
    scopes: compatJsonColumn<string[]>("scopes"),
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

/**
 * The last time one member's credentials were revoked in one organization (member removed, role or role permissions
 * changed, ownership transferred). The exchange refuses every resume grant authorized before this moment, so a grant
 * minted concurrently with a revocation, and written after it swept the live grants, cannot be used afterwards.
 */
export const HeadlessResumeRevocationTable = mysqlTable(
  "headless_resume_revocation",
  {
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    revokedAt: timestamp("revoked_at", { fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
)
