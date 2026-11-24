import { index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedMediumTextColumn } from "../columns"

export const HARNESS_FEEDBACK_SURFACES: readonly ["tool", "instructions", "skill", "connector", "environment", "other"] =
  ["tool", "instructions", "skill", "connector", "environment", "other"]
export const HARNESS_FEEDBACK_STATES: readonly ["pending", "classified", "rejected", "needs_review"] =
  ["pending", "classified", "rejected", "needs_review"]
export const HARNESS_FEEDBACK_NOTIFY_STATES: readonly ["pending", "delivered", "failed"] = ["pending", "delivered", "failed"]

export const HarnessFeedbackGroupTable = mysqlTable("harness_feedback_group", {
  id: denTypeIdColumn("harnessFeedbackGroup", "id").primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  category: varchar("category", { length: 64 }),
  surface: varchar("surface", { length: 24, enum: HARNESS_FEEDBACK_SURFACES }).notNull(),
  tool: varchar("tool", { length: 80 }),
  reportCount: int("report_count").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { fsp: 3 }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { fsp: 3 }).notNull().defaultNow(),
  notifyState: varchar("notify_state", { length: 16, enum: HARNESS_FEEDBACK_NOTIFY_STATES }).notNull().default("pending"),
  notifyAttempts: int("notify_attempts").notNull().default(0),
  notifyLeaseOwner: varchar("notify_lease_owner", { length: 64 }),
  notifyLeaseExpiresAt: timestamp("notify_lease_expires_at", { fsp: 3 }),
  notifiedAt: timestamp("notified_at", { fsp: 3 }),
}, (t) => [
  uniqueIndex("harness_feedback_group_org_fingerprint").on(t.organizationId, t.fingerprint),
  index("harness_feedback_group_org_seen").on(t.organizationId, t.lastSeenAt),
  index("harness_feedback_group_notify_due").on(t.notifyState, t.notifyLeaseExpiresAt),
])

export const HarnessFeedbackReportTable = mysqlTable("harness_feedback_report", {
  id: denTypeIdColumn("harnessFeedbackReport", "id").primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  memberId: denTypeIdColumn("member", "member_id").notNull(),
  clientKind: varchar("client_kind", { length: 16, enum: ["app", "headless"] }).notNull(),
  surface: varchar("surface", { length: 24, enum: HARNESS_FEEDBACK_SURFACES }).notNull(),
  tool: varchar("tool", { length: 80 }),
  errorCode: varchar("error_code", { length: 64 }),
  symptom: encryptedMediumTextColumn("symptom").notNull(),
  workaround: encryptedMediumTextColumn("workaround"),
  state: varchar("state", { length: 16, enum: HARNESS_FEEDBACK_STATES }).notNull().default("pending"),
  groupId: denTypeIdColumn("harnessFeedbackGroup", "group_id"),
  category: varchar("category", { length: 64 }),
  judgmentDetail: encryptedMediumTextColumn("judgment_detail"),
  attempts: int("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { fsp: 3 }).notNull().defaultNow(),
  leaseOwner: varchar("lease_owner", { length: 64 }),
  leaseExpiresAt: timestamp("lease_expires_at", { fsp: 3 }),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [
  index("harness_feedback_report_due").on(t.state, t.nextAttemptAt, t.leaseExpiresAt),
  index("harness_feedback_report_org_created").on(t.organizationId, t.groupId, t.createdAt),
  index("harness_feedback_report_member_created").on(t.organizationId, t.memberId, t.createdAt),
])
