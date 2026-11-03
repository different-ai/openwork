import { index, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { ACCOUNT_CONFIRMED_OPPORTUNITIES, ACCOUNT_FOLLOW_UP_ACTIONS, ACCOUNT_FOLLOW_UP_STAGES } from "@openwork/types/den/admin-organization"
import { denTypeIdColumn } from "../columns"

/**
 * Platform-admin sales follow-up for one organization. Internal context only:
 * never written to the organization's audit log or shown to its members, and
 * never a trigger for outbound messages.
 */
export const AccountFollowUpTable = mysqlTable("account_follow_up", {
  organizationId: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
  stage: mysqlEnum("stage", ACCOUNT_FOLLOW_UP_STAGES).notNull().default("needs_review"),
  ownerUserId: denTypeIdColumn("user", "owner_user_id"),
  nextAction: varchar("next_action", { length: 240 }),
  nextFollowUpAt: timestamp("next_follow_up_at", { fsp: 3 }),
  lastContactedAt: timestamp("last_contacted_at", { fsp: 3 }),
  confirmedOpportunity: mysqlEnum("confirmed_opportunity", ACCOUNT_CONFIRMED_OPPORTUNITIES),
  updatedByUserId: denTypeIdColumn("user", "updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [index("account_follow_up_due").on(table.stage, table.nextFollowUpAt)])

/** Append-only record of what a platform admin did or learned. Notes are internal. */
export const AccountFollowUpActionTable = mysqlTable("account_follow_up_action", {
  id: denTypeIdColumn("accountFollowUpAction", "id").notNull().primaryKey(),
  organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
  requestId: varchar("request_id", { length: 36 }).notNull(),
  kind: mysqlEnum("kind", ACCOUNT_FOLLOW_UP_ACTIONS).notNull(),
  actorUserId: denTypeIdColumn("user", "actor_user_id").notNull(),
  contactUserId: denTypeIdColumn("user", "contact_user_id"),
  note: varchar("note", { length: 500 }),
  /** The follow-up date this action completed, kept to measure on-time follow-ups. */
  followUpDueAt: timestamp("follow_up_due_at", { fsp: 3 }),
  occurredAt: timestamp("occurred_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [
  uniqueIndex("account_follow_up_action_request").on(table.organizationId, table.requestId),
  index("account_follow_up_action_org_time").on(table.organizationId, table.occurredAt),
  index("account_follow_up_action_time").on(table.occurredAt),
])
