import { boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedMediumTextColumn, encryptedTextColumn } from "../columns"

// One app per connector; teamId is globally unique so a Slack workspace cannot
// accidentally route into two OpenWork organizations.
export const SlackAssistantInstallationTable = mysqlTable(
  "slack_assistant_installation",
  {
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    signingSecret: encryptedTextColumn("signing_secret").notNull(),
    teamId: varchar("team_id", { length: 64 }),
    appId: varchar("app_id", { length: 64 }),
    botUserId: varchar("bot_user_id", { length: 64 }),
    botToken: encryptedTextColumn("bot_token"),
    channelIds: compatJsonColumn<string[]>("channel_ids"),
    shadowMode: boolean("shadow_mode").notNull().default(false),
    dailyLimit: int("daily_limit").notNull().default(100),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("slack_assistant_team").on(t.teamId)],
)

export const SlackAssistantIdentityTable = mysqlTable(
  "slack_assistant_identity",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    teamId: varchar("team_id", { length: 64 }).notNull(),
    slackUserId: varchar("slack_user_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("slack_assistant_identity_actor").on(t.connectionId, t.teamId, t.slackUserId),
    uniqueIndex("slack_assistant_identity_member").on(t.connectionId, t.memberId),
  ],
)

export const SlackAssistantThreadTable = mysqlTable(
  "slack_assistant_thread",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    channelId: varchar("channel_id", { length: 64 }).notNull(),
    threadTs: varchar("thread_ts", { length: 64 }).notNull(),
    sessionId: varchar("session_id", { length: 240 }),
    workspaceId: varchar("workspace_id", { length: 240 }),
    activeEventId: varchar("active_event_id", { length: 64 }),
  },
  (t) => [index("slack_assistant_thread_member").on(t.connectionId, t.memberId)],
)

export const SlackAssistantEventTable = mysqlTable(
  "slack_assistant_event",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
    teamId: varchar("team_id", { length: 64 }).notNull(),
    slackUserId: varchar("slack_user_id", { length: 64 }).notNull(),
    channelId: varchar("channel_id", { length: 64 }).notNull(),
    threadTs: varchar("thread_ts", { length: 64 }).notNull(),
    // Text, context, and output never appear in queue metadata or logs.
    payload: encryptedMediumTextColumn("payload").notNull(),
    checkpoint: encryptedMediumTextColumn("checkpoint"),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { fsp: 3 }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { fsp: 3 }),
    leaseOwner: varchar("lease_owner", { length: 64 }),
    cancelled: boolean("cancelled").notNull().default(false),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("slack_assistant_event_queue").on(t.status, t.availableAt),
    index("slack_assistant_event_actor").on(t.connectionId, t.slackUserId, t.createdAt),
  ],
)

export const SlackAssistantOAuthStateTable = mysqlTable(
  "slack_assistant_oauth_state",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  },
  (t) => [index("slack_assistant_oauth_expiry").on(t.expiresAt)],
)
