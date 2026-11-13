import { boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn, encryptedTextColumn } from "../columns"

/** A trusted hosted turn binding, never accepted from MCP tool arguments. No bearer token is retained. */
export const McpEventTurnTable = mysqlTable("mcp_event_turn", {
  tokenId: denTypeIdColumn("oauthAccessToken", "token_id").notNull().primaryKey(),
  resumeGrantId: denTypeIdColumn("headlessResumeGrant", "resume_grant_id"),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  userId: denTypeIdColumn("user", "user_id").notNull(),
  memberId: denTypeIdColumn("member", "member_id").notNull(),
  sessionId: varchar("session_id", { length: 128 }).notNull(),
  model: varchar("model", { length: 512 }).notNull(),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
}, (t) => [index("mcp_event_turn_expiry").on(t.expiresAt), index("mcp_event_turn_resume_grant").on(t.resumeGrantId)])

/** Finite subscriptions. Secret, filters and saved instruction are encrypted using Den's existing key. */
export const McpEventSubscriptionTable = mysqlTable("mcp_event_subscription", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  userId: denTypeIdColumn("user", "user_id").notNull(),
  memberId: denTypeIdColumn("member", "member_id").notNull(),
  sessionId: varchar("session_id", { length: 128 }).notNull(),
  connectionId: denTypeIdColumn("externalMcpConnection", "connection_id"),
  source: varchar("source", { length: 16 }).notNull().default("connection"),
  name: varchar("name", { length: 256 }).notNull(),
  arguments: encryptedMediumTextColumn("arguments").notNull(),
  instruction: encryptedTextColumn("instruction").notNull(),
  secret: encryptedTextColumn("secret").notNull(),
  callbackUrl: varchar("callback_url", { length: 2048 }).notNull(),
  remoteId: varchar("remote_id", { length: 512 }),
  cursor: encryptedTextColumn("cursor"),
  incomplete: boolean("incomplete").notNull().default(false),
  model: varchar("model", { length: 512 }).notNull(),
  scopes: compatJsonColumn<string[]>("scopes").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index("mcp_event_subscription_thread").on(t.organizationId, t.memberId, t.sessionId), index("mcp_event_subscription_expiry").on(t.status, t.expiresAt)])

/** Receipt id is SHA-256(subscription id, event id); it is also the runner's idempotent message id. */
export const McpEventReceiptTable = mysqlTable("mcp_event_receipt", {
  id: varchar("id", { length: 80 }).notNull().primaryKey(),
  subscriptionId: varchar("subscription_id", { length: 64 }).notNull(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  payload: encryptedMediumTextColumn("payload"),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  attempts: int("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { fsp: 3 }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index("mcp_event_receipt_subscription").on(t.subscriptionId), index("mcp_event_receipt_queue").on(t.status, t.availableAt), index("mcp_event_receipt_outcomes").on(t.createdAt, t.organizationId)])


/** Finite subscriptions published by OpenWork; no execution authority is stored in a payload. */
export const McpNativeSubscriptionTable = mysqlTable("mcp_native_subscription", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  identity: varchar("identity", { length: 64 }).notNull(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  userId: denTypeIdColumn("user", "user_id").notNull(),
  memberId: denTypeIdColumn("member", "member_id").notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  arguments: encryptedTextColumn("arguments").notNull(),
  callbackUrl: varchar("callback_url", { length: 2048 }),
  secret: encryptedTextColumn("secret"),
  previousSecret: encryptedTextColumn("previous_secret"),
  rotateUntil: timestamp("rotate_until", { fsp: 3 }),
  verifiedAt: timestamp("verified_at", { fsp: 3 }),
  verificationToken: varchar("verification_token", { length: 48 }),
  verificationUntil: timestamp("verification_until", { fsp: 3 }),
  threadWatchId: varchar("thread_watch_id", { length: 64 }),
  observation: varchar("observation", { length: 64 }).notNull(),
  sequence: int("sequence").notNull().default(0),
  status: varchar("status", { length: 16 }).notNull(),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  availableAt: timestamp("available_at", { fsp: 3 }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [uniqueIndex("mcp_native_subscription_identity").on(t.identity), index("mcp_native_subscription_queue").on(t.status, t.availableAt)])

export const McpNativeDeliveryTable = mysqlTable("mcp_native_delivery", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  subscriptionId: varchar("subscription_id", { length: 64 }).notNull(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  payload: encryptedMediumTextColumn("payload"),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  attempts: int("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { fsp: 3 }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index("mcp_native_delivery_queue").on(t.status, t.availableAt), index("mcp_native_delivery_subscription").on(t.subscriptionId), index("mcp_native_delivery_outcomes").on(t.createdAt, t.organizationId)])
