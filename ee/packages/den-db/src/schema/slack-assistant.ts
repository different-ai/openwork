import { boolean, index, int, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
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
    /** Gateway model alias the headless runner uses for this workspace; null means the runner default. */
    model: varchar("model", { length: 255 }),
    /** Show steps and notes in Slack while a task works; off shows only Slack's working status, then the answer. */
    progressUpdates: boolean("progress_updates").notNull().default(false),
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

/**
 * Which Slack run a headless-run MCP token was minted for. Den writes this row
 * itself when it mints the token, so a tool call made with that token can be
 * traced back to its Slack thread without trusting anything the model sends.
 */
export const SlackAssistantRunTokenTable = mysqlTable(
  "slack_assistant_run_token",
  {
    tokenId: denTypeIdColumn("oauthAccessToken", "token_id").primaryKey(),
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
    eventId: varchar("event_id", { length: 64 }).notNull(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  },
  (t) => [index("slack_assistant_run_token_expiry").on(t.expiresAt)],
)

/**
 * Work a Slack run handed to the member's desktop (`remote-session:create`
 * with target "desktop"). The outcome is posted to the originating thread once;
 * `postedOutcome` stays null until then. Leases let several Den instances share
 * the sweep without posting twice.
 */
export const SlackAssistantDesktopHandoffTable = mysqlTable(
  "slack_assistant_desktop_handoff",
  {
    commandId: denTypeIdColumn("remoteSessionCommand", "command_id").primaryKey(),
    connectionId: denTypeIdColumn("externalMcpConnection", "connection_id").notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The member whose desktop runs the work; the command is read as them. */
    userId: denTypeIdColumn("user", "user_id").notNull(),
    eventId: varchar("event_id", { length: 64 }).notNull(),
    teamId: varchar("team_id", { length: 64 }).notNull(),
    channelId: varchar("channel_id", { length: 64 }).notNull(),
    threadTs: varchar("thread_ts", { length: 64 }).notNull(),
    recipientUserId: varchar("recipient_user_id", { length: 64 }).notNull(),
    postedOutcome: mysqlEnum("posted_outcome", ["finished", "failed", "expired", "undeliverable", "abandoned"]),
    /** The current waiting episode was already announced; cleared when the session moves on. */
    waitingPosted: boolean("waiting_posted").notNull().default(false),
    attempts: int("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { fsp: 3 }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { fsp: 3 }),
    leaseOwner: varchar("lease_owner", { length: 64 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => [index("slack_assistant_desktop_handoff_queue").on(t.postedOutcome, t.availableAt)],
)
