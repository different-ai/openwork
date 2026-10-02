import { bigint, boolean, char, index, int, mysqlEnum, mysqlTable, primaryKey, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, timestamps } from "../columns"
import type { AuditActor, AuditCategory } from "../audit-log"

export const AuditPolicyTable = mysqlTable("audit_policy", {
  organization_id: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
  revision: int("revision", { unsigned: true }).notNull(),
  source: mysqlEnum("source", ["cloud", "operator"]).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  categories: compatJsonColumn<AuditCategory[]>("categories").notNull(),
  allowance: bigint("allowance", { mode: "number", unsigned: true }).notNull(),
  excess_mode: mysqlEnum("excess_mode", ["delete_oldest", "paid_overage", "keep_all"]).notNull(),
  effective_at: timestamp("effective_at", { fsp: 3 }).notNull(),
  capture_started_at: timestamp("capture_started_at", { fsp: 3 }),
  attachment_window_seconds: int("attachment_window_seconds", { unsigned: true }).notNull(),
})

export const AuditStateTable = mysqlTable("audit_state", {
  organization_id: denTypeIdColumn("organization", "organization_id").notNull().primaryKey(),
  last_sequence: bigint("last_sequence", { mode: "number", unsigned: true }).notNull().default(0),
  retained_operations: bigint("retained_operations", { mode: "number", unsigned: true }).notNull().default(0),
  event_count: bigint("event_count", { mode: "number", unsigned: true }).notNull().default(0),
  logical_bytes: bigint("logical_bytes", { mode: "number", unsigned: true }).notNull().default(0),
  updated_at: timestamps.updated_at,
})

export const AuditOperationTable = mysqlTable("audit_operation", {
  id: denTypeIdColumn("auditOperation", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  binding_key: char("binding_key", { length: 64 }).notNull(),
  kind: varchar("kind", { length: 128 }).notNull(),
  scope: varchar("scope", { length: 512 }).notNull(),
  principal_key: varchar("principal_key", { length: 512 }).notNull(),
  initiating_actor: compatJsonColumn<AuditActor>("initiating_actor").notNull(),
  origin: mysqlEnum("origin", ["api", "cloud_ui", "mcp", "scheduler", "webhook", "platform_admin"]).notNull(),
  origin_trust: mysqlEnum("origin_trust", ["authenticated", "reported"]).notNull(),
  first_recorded_at: timestamp("first_recorded_at", { fsp: 3 }).notNull(),
  attachment_expires_at: timestamp("attachment_expires_at", { fsp: 3 }).notNull(),
  outcome: mysqlEnum("outcome", ["running", "succeeded", "failed", "partial", "unknown"]).notNull().default("unknown"),
  retention_state: mysqlEnum("retention_state", ["retained", "evicting"]).notNull().default("retained"),
  event_count: bigint("event_count", { mode: "number", unsigned: true }).notNull().default(0),
  logical_bytes: bigint("logical_bytes", { mode: "number", unsigned: true }).notNull().default(0),
}, (table) => [
  uniqueIndex("audit_operation_binding").on(table.organization_id, table.binding_key),
  index("audit_operation_org_time").on(table.organization_id, table.first_recorded_at, table.id),
  index("audit_operation_retention").on(table.organization_id, table.retention_state, table.first_recorded_at, table.id),
])

export const AuditOperationStepTable = mysqlTable("audit_operation_step", {
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  operation_id: denTypeIdColumn("auditOperation", "operation_id").notNull(),
  step_hash: char("step_hash", { length: 64 }).notNull(),
  workflow_step: varchar("workflow_step", { length: 128 }).notNull(),
  step_scope: varchar("step_scope", { length: 512 }).notNull(),
  request_id: varchar("request_id", { length: 128 }).notNull(),
}, (table) => [
  primaryKey({ name: "audit_operation_step_pk", columns: [table.organization_id, table.operation_id, table.step_hash] }),
])

export const AuditEventResourceTable = mysqlTable("audit_event_resource", {
  id: denTypeIdColumn("auditEventResource", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  event_id: denTypeIdColumn("auditEvent", "event_id").notNull(),
  operation_id: denTypeIdColumn("auditOperation", "operation_id").notNull(),
  resource_type: varchar("resource_type", { length: 64 }).notNull(),
  resource_id: varchar("resource_id", { length: 255 }).notNull(),
  relationship: mysqlEnum("relationship", ["target", "parent", "related"]).notNull(),
  label: varchar("label", { length: 255 }),
}, (table) => [
  index("audit_resource_lookup").on(table.organization_id, table.resource_type, table.resource_id, table.operation_id),
  index("audit_resource_event").on(table.organization_id, table.event_id),
  index("audit_resource_operation").on(table.organization_id, table.operation_id),
])

export const AuditUsageFactTable = mysqlTable("audit_usage_fact", {
  id: denTypeIdColumn("auditUsageFact", "id").notNull().primaryKey(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  operation_id: denTypeIdColumn("auditOperation", "operation_id").notNull(),
  delta: int("delta").$type<1 | -1>().notNull(),
  effective_at: timestamp("effective_at", { fsp: 3 }).notNull(),
  policy_revision: int("policy_revision", { unsigned: true }).notNull(),
  allowance: bigint("allowance", { mode: "number", unsigned: true }).notNull(),
  excess_mode: mysqlEnum("excess_mode", ["delete_oldest", "paid_overage", "keep_all"]).notNull(),
}, (table) => [
  uniqueIndex("audit_usage_operation_transition").on(table.organization_id, table.operation_id, table.delta),
  index("audit_usage_org_time").on(table.organization_id, table.effective_at, table.id),
])
