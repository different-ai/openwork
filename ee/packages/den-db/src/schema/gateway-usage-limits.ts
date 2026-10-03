import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { denTypeIdColumn, legacyUuidDenTypeIdColumn } from "../columns"

export type GatewayUsagePolicyId = DenTypeId<"gatewayUsagePolicy">
export type GatewayUsageAssignmentId = DenTypeId<"gatewayUsageAssignment">
export type GatewayUsageResetRequestId = DenTypeId<"gatewayUsageResetRequest">

/** Placeholder policy reference for a usage window that no policy limits. */
export const GATEWAY_USAGE_UNLIMITED_POLICY_ID: "unlimited" = "unlimited"

// Buckets (content hashes), events and quarantine rows (gateway request IDs)
// are keyed by values that are not Den TypeIDs; they keep plain string keys.
const id = () => varchar("id", { length: 64 }).notNull().primaryKey()
// Policies, assignments, reset requests and audit rows were keyed by plain
// UUIDs before adopting TypeIDs. These columns read legacy rows as TypeIDs
// until `convertGatewayUsageLegacyIds` has rewritten them.
const policyId = (column: string) => legacyUuidDenTypeIdColumn("gatewayUsagePolicy", column)
const policySnapshotId = (column: string) =>
  legacyUuidDenTypeIdColumn("gatewayUsagePolicy", column, [GATEWAY_USAGE_UNLIMITED_POLICY_ID])
const org = () => denTypeIdColumn("organization", "organization_id").notNull()
const member = () => denTypeIdColumn("member", "member_id").notNull()
const timeframe = () => mysqlEnum("timeframe", ["day", "week", "month"]).notNull()
const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0)
const date = (name: string) => timestamp(name, { fsp: 3 }).notNull()

export const GatewayUsagePolicyTable = mysqlTable(
  "gateway_usage_limit_policy",
  {
    id: policyId("id").notNull().primaryKey(),
    organizationId: org(),
    name: varchar("name", { length: 120 }).notNull(),
    hardLimit: boolean("hard_limit").notNull().default(true),
    allowRequestReset: boolean("allow_request_reset").notNull().default(true),
    revision: int("revision").notNull().default(1),
    archivedAt: timestamp("archived_at", { fsp: 3 }),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
    createdBy: member(),
  },
  (t) => [index("gateway_usage_policy_org").on(t.organizationId)],
)
export const GatewayUsageLimitTable = mysqlTable(
  "gateway_usage_limit_entry",
  {
    policyId: policyId("policy_id").notNull(),
    timeframe: timeframe(),
    costLimitMicroUsd: money("cost_limit_micro_usd"),
  },
  (t) => [
    primaryKey({ columns: [t.policyId, t.timeframe] }),
    check(
      "gateway_usage_allowance_safe",
      sql`${t.costLimitMicroUsd} >= 0 and ${t.costLimitMicroUsd} <= 7205759403792792`,
    ),
  ],
)
export const GatewayUsageAssignmentTable = mysqlTable(
  "gateway_usage_limit_assignment",
  {
    id: legacyUuidDenTypeIdColumn("gatewayUsageAssignment", "id").notNull().primaryKey(),
    policyId: policyId("policy_id").notNull(),
    organizationId: org(),
    memberId: denTypeIdColumn("member", "member_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    organization: boolean("organization"),
    createdAt: date("created_at"),
  },
  (t) => [
    uniqueIndex("gateway_usage_assignment_member").on(t.policyId, t.memberId),
    uniqueIndex("gateway_usage_assignment_team").on(t.policyId, t.teamId),
    uniqueIndex("gateway_usage_assignment_organization").on(
      t.organizationId,
      t.policyId,
      t.organization,
    ),
    index("gateway_usage_assignment_org").on(t.organizationId),
    index("gateway_usage_assignment_member_lookup").on(t.organizationId, t.memberId),
    index("gateway_usage_assignment_team_lookup").on(t.organizationId, t.teamId),
    check(
      "gateway_usage_assignment_target",
      sql`(${t.organization} is null and ((${t.memberId} is null) <> (${t.teamId} is null))) or (${t.organization} is not null and ${t.organization} = 1 and ${t.memberId} is null and ${t.teamId} is null)`,
    ),
  ],
)
export const GatewayUsageSubjectTable = mysqlTable("gateway_usage_subject", {
  memberId: member().primaryKey(),
  organizationId: org(),
  trackingSince: date("tracking_since"),
  initializedAt: date("initialized_at"),
})
export const GatewayUsageTrackingTable = mysqlTable(
  "gateway_usage_tracking",
  {
    memberId: member().primaryKey(),
    organizationId: org(),
    trackingStartedAt: date("tracking_started_at"),
    epochVersion: int("epoch_version").notNull().default(1),
    captureEnabled: boolean("capture_enabled").notNull().default(false),
    pendingRequests: money("pending_requests"),
    lastSettlementAt: timestamp("last_settlement_at", { fsp: 3 }),
    lastSettlementRequestId: varchar("last_settlement_request_id", { length: 64 }),
  },
  (t) => [
    index("gateway_usage_tracking_org").on(t.organizationId),
    check(
      "gateway_usage_tracking_pending_safe",
      sql`${t.pendingRequests} between 0 and 9007199254740991`,
    ),
  ],
)
export const GatewayUsageBucketTable = mysqlTable(
  "gateway_usage_bucket",
  {
    id: id(),
    organizationId: org(),
    memberId: member(),
    timeframe: timeframe(),
    startAt: date("start_at"),
    resetAt: date("reset_at"),
    policyId: policySnapshotId("policy_id").notNull(),
    policyName: varchar("policy_name", { length: 120 }).notNull(),
    policyRevision: int("policy_revision").notNull(),
    baseAllowanceMicroUsd: money("base_allowance_micro_usd"),
    extensionMicroUsd: money("extension_micro_usd"),
    usedMicroUsd: money("used_micro_usd"),
    unpricedRequests: money("unpriced_requests"),
    incompleteRequests: money("incomplete_requests"),
    historyUnknown: boolean("history_unknown").notNull().default(true),
    extensionUsed: boolean("extension_used").notNull().default(false),
    hardLimit: boolean("hard_limit").notNull(),
    allowRequestReset: boolean("allow_request_reset").notNull(),
  },
  (t) => [
    uniqueIndex("gateway_usage_bucket_window").on(
      t.organizationId,
      t.memberId,
      t.timeframe,
      t.startAt,
    ),
    index("gateway_usage_bucket_member").on(t.memberId, t.resetAt),
    check(
      "gateway_usage_bucket_money_safe",
      sql`${t.usedMicroUsd} between 0 and 9007199254740991 and ${t.baseAllowanceMicroUsd} + ${t.extensionMicroUsd} between 0 and 9007199254740991`,
    ),
  ],
)
export const GatewayUsageEventTable = mysqlTable(
  "gateway_usage_consumption_event",
  {
    id: id(),
    organizationId: org(),
    memberId: member(),
    admittedAt: date("admitted_at"),
    requestStartedAt: timestamp("request_started_at", { fsp: 3 }),
    admissionSnapshot: json("admission_snapshot").$type<unknown>(),
    pendingCounted: boolean("pending_counted").notNull().default(false),
    trackingVersion: int("tracking_version"),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    unpricedRequests: int("unpriced_requests").notNull().default(1),
    complete: boolean("complete").notNull().default(false),
    finalized: boolean("finalized").notNull().default(false),
    source: varchar("source", { length: 32 }).notNull(),
    settledAt: timestamp("settled_at", { fsp: 3 }),
  },
  (t) => [
    index("gateway_usage_event_member_time").on(t.memberId, t.admittedAt),
    index("gateway_usage_pending_member").on(t.memberId, t.pendingCounted, t.admittedAt, t.id),
    check(
      "gateway_usage_event_money_safe",
      sql`${t.costMicroUsd} is null or ${t.costMicroUsd} between 0 and 9007199254740991`,
    ),
  ],
)
export const GatewayUsageQuarantineTable = mysqlTable(
  "gateway_usage_quarantine",
  {
    id: id(),
    organizationId: org(),
    memberId: member(),
    admittedAt: date("admitted_at"),
    receivedAt: date("received_at"),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    reason: varchar("reason", { length: 64 }).notNull(),
  },
  (t) => [index("gateway_usage_quarantine_member_time").on(t.memberId, t.admittedAt)],
)

export const GatewayUsageChargeTable = mysqlTable(
  "gateway_usage_bucket_charge",
  {
    eventId: varchar("event_id", { length: 64 }).notNull(),
    bucketId: varchar("bucket_id", { length: 64 }).notNull(),
    amount: money("amount"),
    unpricedRequests: money("unpriced_requests"),
    incompleteRequests: money("incomplete_requests"),
    policyId: policySnapshotId("policy_id").notNull(),
    policyRevision: int("policy_revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.bucketId] }),
    index("gateway_usage_charge_bucket").on(t.bucketId),
  ],
)
export const GatewayUsageResetTable = mysqlTable(
  "gateway_usage_reset_request",
  {
    id: legacyUuidDenTypeIdColumn("gatewayUsageResetRequest", "id").notNull().primaryKey(),
    organizationId: org(),
    memberId: member(),
    bucketId: varchar("bucket_id", { length: 64 }).notNull(),
    policyId: policySnapshotId("policy_id").notNull(),
    policyRevision: int("policy_revision").notNull(),
    timeframe: timeframe(),
    policyName: varchar("policy_name", { length: 120 }).notNull(),
    reason: text("reason").notNull(),
    status: mysqlEnum("status", ["pending", "approved", "denied", "expired"]).notNull(),
    pendingBucketId: varchar("pending_bucket_id", { length: 64 }),
    baseAllowanceMicroUsd: money("base_allowance_micro_usd"),
    allowanceMicroUsd: money("allowance_micro_usd"),
    usedMicroUsd: money("used_micro_usd"),
    resetAt: date("reset_at"),
    createdAt: date("created_at"),
    reviewedAt: timestamp("reviewed_at", { fsp: 3 }),
    reviewedBy: denTypeIdColumn("member", "reviewed_by"),
    denialNote: text("denial_note"),
  },
  (t) => [
    uniqueIndex("gateway_usage_reset_pending").on(t.pendingBucketId),
    index("gateway_usage_reset_bucket_history").on(t.bucketId, t.createdAt, t.id),
    index("gateway_usage_reset_org").on(t.organizationId, t.createdAt),
    index("gateway_usage_reset_queue").on(t.organizationId, t.status, t.resetAt, t.createdAt, t.id),
    index("gateway_usage_reset_own_queue").on(
      t.organizationId,
      t.memberId,
      t.status,
      t.resetAt,
      t.createdAt,
      t.id,
    ),
    index("gateway_usage_reset_own_history").on(t.organizationId, t.memberId, t.createdAt, t.id),
  ],
)
export const GatewayUsageAuditTable = mysqlTable(
  "gateway_usage_audit",
  {
    id: legacyUuidDenTypeIdColumn("gatewayUsageAudit", "id").notNull().primaryKey(),
    organizationId: org(),
    actorId: denTypeIdColumn("member", "actor_id"),
    // Polymorphic: a policy, reset request, member or gateway request ID, depending on `action`.
    subjectId: varchar("subject_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    details: json("details").$type<Record<string, unknown>>().notNull(),
    createdAt: date("created_at"),
  },
  (t) => [index("gateway_usage_audit_org").on(t.organizationId, t.createdAt)],
)
