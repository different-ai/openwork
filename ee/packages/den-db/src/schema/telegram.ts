import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../columns"

export const telegramConnectionStatusValues = ["active", "error"] as const
export const telegramUpdateStatusValues = ["accepted", "processing", "completed", "ignored", "failed"] as const

/**
 * One organization-owned Telegram bot. Bot tokens and webhook secrets are
 * encrypted by the shared database-column encryption layer.
 */
export const TelegramConnectionTable = mysqlTable(
  "telegram_connection",
  {
    id: denTypeIdColumn("telegramConnection", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    workerId: denTypeIdColumn("worker", "worker_id").notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    botToken: encryptedTextColumn("bot_token").notNull(),
    webhookSecret: encryptedTextColumn("webhook_secret").notNull(),
    botId: varchar("bot_id", { length: 32 }).notNull(),
    botUsername: varchar("bot_username", { length: 64 }),
    botDisplayName: varchar("bot_display_name", { length: 255 }).notNull(),
    status: mysqlEnum("status", telegramConnectionStatusValues).notNull().default("active"),
    webhookRegistered: boolean("webhook_registered").notNull().default(false),
    dispatchToken: varchar("dispatch_token", { length: 64 }),
    dispatchStartedAt: timestamp("dispatch_started_at", { fsp: 3 }),
    lastWebhookAt: timestamp("last_webhook_at", { fsp: 3 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("telegram_connection_organization_id").on(table.organizationId),
    uniqueIndex("telegram_connection_bot_id").on(table.botId),
    index("telegram_connection_worker_id").on(table.workerId),
  ],
)

/** One-time deep-link token. Only its SHA-256 hash is persisted. */
export const TelegramPairingTable = mysqlTable(
  "telegram_pairing",
  {
    id: denTypeIdColumn("telegramPairing", "id").notNull().primaryKey(),
    connectionId: denTypeIdColumn("telegramConnection", "connection_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    usedAt: timestamp("used_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_pairing_token_hash").on(table.tokenHash),
    index("telegram_pairing_connection_id").on(table.connectionId),
    index("telegram_pairing_expires_at").on(table.expiresAt),
  ],
)

/** The one private Telegram chat currently routed to this connection. */
export const TelegramChatBindingTable = mysqlTable(
  "telegram_chat_binding",
  {
    id: denTypeIdColumn("telegramChatBinding", "id").notNull().primaryKey(),
    connectionId: denTypeIdColumn("telegramConnection", "connection_id").notNull(),
    telegramChatId: varchar("telegram_chat_id", { length: 32 }).notNull(),
    telegramUserId: varchar("telegram_user_id", { length: 32 }).notNull(),
    telegramUsername: varchar("telegram_username", { length: 64 }),
    telegramFirstName: varchar("telegram_first_name", { length: 255 }).notNull(),
    workerWorkspaceId: varchar("worker_workspace_id", { length: 255 }),
    workerSessionId: varchar("worker_session_id", { length: 255 }),
    pairedAt: timestamp("paired_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("telegram_chat_binding_connection_id").on(table.connectionId),
    uniqueIndex("telegram_chat_binding_connection_chat").on(table.connectionId, table.telegramChatId),
  ],
)

/** Durable update-id claim used to make webhook retries idempotent. */
export const TelegramUpdateTable = mysqlTable(
  "telegram_update",
  {
    id: denTypeIdColumn("telegramUpdate", "id").notNull().primaryKey(),
    connectionId: denTypeIdColumn("telegramConnection", "connection_id").notNull(),
    updateId: varchar("update_id", { length: 32 }).notNull(),
    payload: encryptedTextColumn("payload").notNull(),
    status: mysqlEnum("status", telegramUpdateStatusValues).notNull().default("accepted"),
    attempts: int("attempts").notNull().default(0),
    processingToken: varchar("processing_token", { length: 64 }),
    processingStartedAt: timestamp("processing_started_at", { fsp: 3 }),
    error: text("error"),
    receivedAt: timestamp("received_at", { fsp: 3 }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { fsp: 3 }),
  },
  (table) => [
    uniqueIndex("telegram_update_connection_update").on(table.connectionId, table.updateId),
    index("telegram_update_dispatch").on(table.status, table.processingStartedAt, table.receivedAt),
    index("telegram_update_received_at").on(table.receivedAt),
  ],
)
