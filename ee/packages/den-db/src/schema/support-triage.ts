import { boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

export const SUPPORT_TRIAGE_ACTION_CATEGORIES: readonly ["bug", "enterprise", "job_ask", "pitch"] = ["bug", "enterprise", "job_ask", "pitch"]
export const SUPPORT_TRIAGE_CATEGORIES: readonly [...typeof SUPPORT_TRIAGE_ACTION_CATEGORIES, "needs_review", "other"] = [...SUPPORT_TRIAGE_ACTION_CATEGORIES, "needs_review", "other"]

export const SupportTriageSettingsTable = mysqlTable("support_triage_settings", {
  id: varchar("id", { length: 16, enum: ["default"] }).primaryKey(),
  plainApiKey: encryptedMediumTextColumn("plain_api_key"),
  slackWebhookUrl: encryptedMediumTextColumn("slack_webhook_url"),
  leadsSlackWebhookUrl: encryptedMediumTextColumn("leads_slack_webhook_url"),
  enabledAt: timestamp("enabled_at", { fsp: 3 }),
  polledThrough: timestamp("polled_through", { fsp: 3 }),
  revision: varchar("revision", { length: 36 }).notNull(),
  updatedBy: denTypeIdColumn("user", "updated_by").notNull(),
  updatedAt: timestamp("updated_at", { fsp: 3 }).notNull(),
})

export const SupportTriageThreadTable = mysqlTable("support_triage_thread", {
  id: denTypeIdColumn("supportTriageThread", "id").primaryKey(),
  plainThreadId: varchar("plain_thread_id", { length: 128 }).notNull(),
  workspaceId: varchar("workspace_id", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull(),
  title: encryptedMediumTextColumn("title").notNull(),
  preview: encryptedMediumTextColumn("preview"),
  status: varchar("status", { length: 16, enum: ["pending", "processing", "completed", "failed"] }).notNull().default("pending"),
  category: varchar("category", { length: 24, enum: SUPPORT_TRIAGE_CATEGORIES }),
  judgmentDetail: encryptedMediumTextColumn("judgment_detail"),
  labelApplied: boolean("label_applied").notNull().default(false),
  dispositionApplied: boolean("disposition_applied").notNull().default(false),
  slackState: varchar("slack_state", { length: 16, enum: ["pending", "sending", "delivered", "failed"] }).notNull().default("pending"),
  attempts: int("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { fsp: 3 }).notNull().defaultNow(),
  leaseOwner: varchar("lease_owner", { length: 36 }),
  leaseExpiresAt: timestamp("lease_expires_at", { fsp: 3 }),
}, (t) => [
  uniqueIndex("support_triage_plain_thread").on(t.plainThreadId),
  index("support_triage_due").on(t.workspaceId, t.status, t.nextAttemptAt, t.leaseExpiresAt),
  index("support_triage_created").on(t.createdAt, t.id),
  index("support_triage_category_created").on(t.category, t.createdAt, t.id),
])
