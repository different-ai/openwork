import { bigint, boolean, index, int, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Den's content-free index of headless runner conversations: one row per Workbot,
 * Slack or Automation session with its sizes, activity and state, never its content. The runner reports each change
 * through `POST /v1/internal/headless/index` with a capability Den minted for that session; the organization, member
 * and kind come only from that capability. Only den-api's session index module reads or writes this table.
 *
 * `retention_class` and `legal_hold` are Den-owned (the runner never sets them). Deployment follow-up: move the table
 * into its own MySQL schema with a database user granted on that schema only (overview §9.3, least privilege).
 */
export const HeadlessSessionIndexTable = mysqlTable(
  "headless_session_index",
  {
    /** The runner session id (`hs_…`). */
    sessionId: varchar("session_id", { length: 128 }).notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "org_id").notNull(),
    /** The member the conversation belongs to; null when the capability named none. */
    memberId: denTypeIdColumn("member", "member_id"),
    kind: mysqlEnum("kind", ["workbot", "slack", "automation"]).notNull(),
    /** The conversation's name as the runner shows it (its first answer names it); at most 200 characters. */
    title: varchar("title", { length: 200 }).notNull().default(""),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull(),
    hotBytes: bigint("hot_bytes", { mode: "number" }).notNull().default(0),
    segmentCount: int("segment_count").notNull().default(0),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    /** When the turn now running started; null when none is. Stuck-turn detection reads it (alerting is Phase 3). */
    activeTurnSince: timestamp("active_turn_since", { fsp: 3 }),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
    /** The runner's per-session snapshot version; an update with a version at or below it changes nothing. */
    version: bigint("version", { mode: "number" }).notNull(),
    retentionClass: varchar("retention_class", { length: 64 }),
    legalHold: boolean("legal_hold").notNull().default(false),
    lastReportedAt: timestamp("last_reported_at", { fsp: 3 }).notNull(),
  },
  (table) => [
    index("headless_session_index_org").on(table.organizationId),
    index("headless_session_index_org_member").on(table.organizationId, table.memberId),
    index("headless_session_index_org_updated").on(table.organizationId, table.updatedAt),
  ],
)
