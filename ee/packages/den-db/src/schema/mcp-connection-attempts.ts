import { sql } from "drizzle-orm"
import { index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type { ConnectionDiagnostic } from "@openwork/types/connection-setup"
import { compatJsonColumn, denTypeIdColumn } from "../columns"

/** Short-lived sign-in outcomes; no authorization URL, verifier, code, or token. */
export const McpConnectionAttemptTable = mysqlTable("mcp_connection_attempt", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
  connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
  identityBinding: varchar("identity_binding", { length: 64 }).notNull(),
  stateHash: varchar("state_hash", { length: 64 }).notNull(),
  status: mysqlEnum("status", ["pending", "authorized", "failed"]).notNull(),
  diagnostic: compatJsonColumn<ConnectionDiagnostic>("diagnostic"),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}, table => [
  uniqueIndex("mcp_connection_attempt_state").on(table.stateHash),
  index("mcp_connection_attempt_owner").on(table.organizationId, table.orgMembershipId, table.connectionId),
  index("mcp_connection_attempt_expiry").on(table.expiresAt),
])
