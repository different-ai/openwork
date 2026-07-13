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

export const tagConnectionStatusValues = ["active", "error"] as const
export const tagInstallSourceValues = ["manual", "oauth"] as const
export const tagEventStatusValues = ["accepted", "processing", "completed", "ignored", "failed"] as const
export const tagThreadStatusValues = ["active", "cancelled"] as const
export const tagRunStatusValues = ["accepted", "running", "completed", "failed", "cancelled"] as const

/** One organization-owned Slack installation. Secrets never leave Den. */
export const TagConnectionTable = mysqlTable(
  "tag_connection",
  {
    id: denTypeIdColumn("tagConnection", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    workerId: denTypeIdColumn("worker", "worker_id").notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    botToken: encryptedTextColumn("bot_token").notNull(),
    signingSecret: encryptedTextColumn("signing_secret").notNull(),
    installSource: mysqlEnum("install_source", tagInstallSourceValues).notNull().default("manual"),
    slackAppId: varchar("slack_app_id", { length: 32 }),
    slackEnterpriseId: varchar("slack_enterprise_id", { length: 32 }),
    isEnterpriseInstall: boolean("is_enterprise_install").notNull().default(false),
    oauthScopes: text("oauth_scopes"),
    refreshToken: encryptedTextColumn("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { fsp: 3 }),
    tokenRefreshedAt: timestamp("token_refreshed_at", { fsp: 3 }),
    tokenRefreshLease: varchar("token_refresh_lease", { length: 64 }),
    tokenRefreshStartedAt: timestamp("token_refresh_started_at", { fsp: 3 }),
    revokedAt: timestamp("revoked_at", { fsp: 3 }),
    slackTeamId: varchar("slack_team_id", { length: 32 }).notNull(),
    slackTeamName: varchar("slack_team_name", { length: 255 }).notNull(),
    botUserId: varchar("bot_user_id", { length: 32 }).notNull(),
    botName: varchar("bot_name", { length: 255 }).notNull(),
    serviceName: varchar("service_name", { length: 80 }).notNull().default("OpenWork"),
    defaultInstructions: text("default_instructions").notNull(),
    allowedUserIds: text("allowed_user_ids").notNull(),
    allowGuests: boolean("allow_guests").notNull().default(false),
    allowSharedChannels: boolean("allow_shared_channels").notNull().default(false),
    status: mysqlEnum("status", tagConnectionStatusValues).notNull().default("active"),
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
    uniqueIndex("tag_connection_organization_id").on(table.organizationId),
    uniqueIndex("tag_connection_slack_team_id").on(table.slackTeamId),
    index("tag_connection_worker_id").on(table.workerId),
  ],
)

/** Single-use server-side OAuth setup. Policy never travels through Slack state. */
export const TagOAuthStateTable = mysqlTable(
  "tag_oauth_state",
  {
    id: denTypeIdColumn("tagOAuthState", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    payload: encryptedTextColumn("payload").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    consumedAt: timestamp("consumed_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tag_oauth_state_hash").on(table.stateHash),
    index("tag_oauth_state_expiry").on(table.expiresAt),
    index("tag_oauth_state_organization").on(table.organizationId),
  ],
)

/** Explicit channel allowlist. Tag ignores every channel not present here. */
export const TagChannelTable = mysqlTable(
  "tag_channel",
  {
    id: denTypeIdColumn("tagChannel", "id").notNull().primaryKey(),
    connectionId: denTypeIdColumn("tagConnection", "connection_id").notNull(),
    slackChannelId: varchar("slack_channel_id", { length: 32 }).notNull(),
    slackChannelName: varchar("slack_channel_name", { length: 255 }),
    instructions: text("instructions"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("tag_channel_connection_channel").on(table.connectionId, table.slackChannelId),
    index("tag_channel_connection_id").on(table.connectionId),
  ],
)

/** Durable Slack event envelope, encrypted and deduped by event_id. */
export const TagEventTable = mysqlTable(
  "tag_event",
  {
    id: denTypeIdColumn("tagEvent", "id").notNull().primaryKey(),
    connectionId: denTypeIdColumn("tagConnection", "connection_id").notNull(),
    slackEventId: varchar("slack_event_id", { length: 64 }).notNull(),
    payload: encryptedTextColumn("payload").notNull(),
    status: mysqlEnum("status", tagEventStatusValues).notNull().default("accepted"),
    attempts: int("attempts").notNull().default(0),
    processingToken: varchar("processing_token", { length: 64 }),
    processingStartedAt: timestamp("processing_started_at", { fsp: 3 }),
    error: text("error"),
    receivedAt: timestamp("received_at", { fsp: 3 }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { fsp: 3 }),
  },
  (table) => [
    uniqueIndex("tag_event_connection_event").on(table.connectionId, table.slackEventId),
    index("tag_event_dispatch").on(table.status, table.processingStartedAt, table.receivedAt),
    index("tag_event_received_at").on(table.receivedAt),
  ],
)

/** One Slack thread owns one durable OpenCode session and immutable config snapshot. */
export const TagThreadTable = mysqlTable(
  "tag_thread",
  {
    id: denTypeIdColumn("tagThread", "id").notNull().primaryKey(),
    connectionId: denTypeIdColumn("tagConnection", "connection_id").notNull(),
    enterpriseId: varchar("enterprise_id", { length: 32 }),
    slackTeamId: varchar("slack_team_id", { length: 32 }).notNull(),
    slackChannelId: varchar("slack_channel_id", { length: 32 }).notNull(),
    slackThreadTs: varchar("slack_thread_ts", { length: 32 }).notNull(),
    startedBySlackUserId: varchar("started_by_slack_user_id", { length: 32 }).notNull(),
    workerWorkspaceId: varchar("worker_workspace_id", { length: 255 }),
    workerSessionId: varchar("worker_session_id", { length: 255 }),
    configSnapshot: text("config_snapshot").notNull(),
    configSnapshotHash: varchar("config_snapshot_hash", { length: 64 }).notNull(),
    status: mysqlEnum("status", tagThreadStatusValues).notNull().default("active"),
    lastMessageAt: timestamp("last_message_at", { fsp: 3 }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("tag_thread_connection_channel_thread").on(
      table.connectionId,
      table.slackChannelId,
      table.slackThreadTs,
    ),
    index("tag_thread_worker_session").on(table.workerSessionId),
    index("tag_thread_last_message_at").on(table.lastMessageAt),
  ],
)

/** Auditable terminal record for each accepted Slack request. */
export const TagRunTable = mysqlTable(
  "tag_run",
  {
    id: denTypeIdColumn("tagRun", "id").notNull().primaryKey(),
    threadId: denTypeIdColumn("tagThread", "thread_id").notNull(),
    eventId: denTypeIdColumn("tagEvent", "event_id").notNull(),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    prompt: encryptedTextColumn("prompt").notNull(),
    response: encryptedTextColumn("response"),
    status: mysqlEnum("status", tagRunStatusValues).notNull().default("accepted"),
    slackStatusMessageTs: varchar("slack_status_message_ts", { length: 32 }),
    error: text("error"),
    startedAt: timestamp("started_at", { fsp: 3 }),
    completedAt: timestamp("completed_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("tag_run_event_id").on(table.eventId),
    index("tag_run_thread_created").on(table.threadId, table.createdAt),
    index("tag_run_status_created").on(table.status, table.createdAt),
  ],
)
