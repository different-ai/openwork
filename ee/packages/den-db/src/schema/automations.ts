import { relations, sql } from "drizzle-orm"
import { bigint, index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type {
  AutomationAction,
  AutomationDesktopRunnerCapability,
  AutomationError,
  AutomationNeedsAttentionReason,
  AutomationRunEventType,
  AutomationSchedule,
  AutomationUsage,
} from "@openwork/types/automations"
import { compatJsonColumn, denTypeIdColumn, encryptedColumn, encryptedMediumTextColumn, timestamps } from "../columns"

const encryptedJsonColumn = <TData>(name: string) => encryptedColumn<TData>(name, {
  dataType: "mediumtext",
  serialize: JSON.stringify,
  deserialize: JSON.parse,
})

const automationStates = ["active", "inactive", "needs_attention", "archived"] as const
const runTriggers = ["scheduled", "recovery", "manual"] as const
const runStatuses = ["queued", "claimed", "running", "succeeded", "failed", "cancelled", "skipped"] as const
const runEventTypes = [
  "user", "assistant", "capability_search", "capability_execution", "usage", "warning", "terminal",
] as const satisfies readonly AutomationRunEventType[]

export const AutomationTable = mysqlTable(
  "automation",
  {
    id: denTypeIdColumn("automation", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    state: mysqlEnum("state", automationStates).notNull().default("active"),
    current_revision_id: denTypeIdColumn("automationRevision", "current_revision_id").notNull(),
    next_due_at: timestamp("next_due_at", { fsp: 3 }),
    latest_run_at: timestamp("latest_run_at", { fsp: 3 }),
    needs_attention_reason: compatJsonColumn<AutomationNeedsAttentionReason | null>("needs_attention_reason"),
    latest_successful_run_id: denTypeIdColumn("automationRun", "latest_successful_run_id"),
    latest_successful_result: encryptedJsonColumn<unknown>("latest_successful_result"),
    archived_at: timestamp("archived_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("automation_org_owner_state").on(table.organization_id, table.owner_member_id, table.state),
    index("automation_due").on(table.state, table.next_due_at),
  ],
)

export const AutomationRevisionTable = mysqlTable(
  "automation_revision",
  {
    id: denTypeIdColumn("automationRevision", "id").notNull().primaryKey(),
    automation_id: denTypeIdColumn("automation", "automation_id").notNull(),
    version: int("version").notNull(),
    instructions: encryptedMediumTextColumn("instructions").notNull(),
    schedule_kind: mysqlEnum("schedule_kind", ["once", "daily", "weekly"]).notNull(),
    schedule_config: compatJsonColumn<AutomationSchedule>("schedule_config").notNull(),
    timezone: varchar("timezone", { length: 120 }).notNull(),
    provider_id: varchar("provider_id", { length: 160 }).notNull(),
    model_id: varchar("model_id", { length: 240 }).notNull(),
    model_variant: varchar("model_variant", { length: 60 }),
    action: encryptedJsonColumn<AutomationAction>("action"),
    execution_target: mysqlEnum("execution_target", ["desktop", "cloud"]).notNull().default("desktop"),
    /** Pinned target workspace; null keeps the legacy run-time active-workspace fallback. */
    workspace_id: varchar("workspace_id", { length: 240 }),
    maximum_runtime_ms: int("maximum_runtime_ms").notNull(),
    digest: varchar("digest", { length: 128 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("automation_revision_version").on(table.automation_id, table.version),
  ],
)

export const AutomationRunnerTable = mysqlTable(
  "automation_runner",
  {
    id: varchar("id", { length: 160 }).notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    protocol_version: int("protocol_version").notNull(),
    supported_execution_targets: json("supported_execution_targets").$type<Array<"desktop">>().notNull(),
    capabilities: json("capabilities").$type<AutomationDesktopRunnerCapability[]>(),
    app_version: varchar("app_version", { length: 80 }).notNull(),
    platform: mysqlEnum("platform", ["darwin", "win32", "linux"]).notNull(),
    concurrency: int("concurrency").notNull(),
    last_seen_at: timestamp("last_seen_at", { fsp: 3 }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("automation_runner_owner_seen").on(table.organization_id, table.owner_member_id, table.last_seen_at),
  ],
)

export const AutomationRunTable = mysqlTable(
  "automation_run",
  {
    id: denTypeIdColumn("automationRun", "id").notNull().primaryKey(),
    automation_id: denTypeIdColumn("automation", "automation_id").notNull(),
    revision_id: denTypeIdColumn("automationRevision", "revision_id").notNull(),
    trigger: mysqlEnum("trigger", runTriggers).notNull(),
    scheduled_for: timestamp("scheduled_for", { fsp: 3 }),
    idempotency_key: varchar("idempotency_key", { length: 512 }).notNull(),
    status: mysqlEnum("status", runStatuses).notNull().default("queued"),
    execution_target: mysqlEnum("execution_target", ["desktop", "cloud"]).notNull().default("desktop"),
    claim_deadline_at: timestamp("claim_deadline_at", { fsp: 3 }),
    lease_owner: varchar("lease_owner", { length: 240 }),
    lease_expires_at: timestamp("lease_expires_at", { fsp: 3 }),
    heartbeat_at: timestamp("heartbeat_at", { fsp: 3 }),
    attempt_count: int("attempt_count").notNull().default(0),
    cloud_thread_id: denTypeIdColumn("automationThread", "cloud_thread_id").notNull(),
    engine_kind: varchar("engine_kind", { length: 160 }),
    engine_receipt: compatJsonColumn<Record<string, unknown> | null>("engine_receipt"),
    engine_sequence: int("engine_sequence").notNull().default(0),
    engine_admitted_at: timestamp("engine_admitted_at", { fsp: 3 }),
    provider_id: varchar("provider_id", { length: 160 }).notNull(),
    model_id: varchar("model_id", { length: 240 }).notNull(),
    model_variant: varchar("model_variant", { length: 60 }),
    started_at: timestamp("started_at", { fsp: 3 }),
    finished_at: timestamp("finished_at", { fsp: 3 }),
    error: compatJsonColumn<AutomationError | null>("error"),
    result_summary: text("result_summary"),
    codemode_receipt_id: denTypeIdColumn("workflowRun", "codemode_receipt_id"),
    validated_result: encryptedJsonColumn<unknown>("validated_result"),
    usage: compatJsonColumn<AutomationUsage>("usage").notNull(),
    cancel_requested_at: timestamp("cancel_requested_at", { fsp: 3 }),
    mcp_token_hash: varchar("mcp_token_hash", { length: 128 }),
    mcp_token_expires_at: timestamp("mcp_token_expires_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("automation_run_occurrence").on(table.idempotency_key),
    uniqueIndex("automation_run_cloud_thread").on(table.cloud_thread_id),
    index("automation_run_claimable").on(table.status, table.lease_expires_at),
    index("automation_run_history").on(table.automation_id, table.created_at),
  ],
)

export const AutomationRunnerNotificationTable = mysqlTable(
  "automation_runner_notification",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    event_type: mysqlEnum("event_type", ["work_available", "cancellation"]).notNull(),
    run_id: denTypeIdColumn("automationRun", "run_id").notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("automation_runner_notification_owner_cursor").on(
      table.organization_id,
      table.owner_member_id,
      table.id,
    ),
  ],
)

export const AutomationRunEventTable = mysqlTable(
  "automation_run_event",
  {
    id: denTypeIdColumn("automationRunEvent", "id").notNull().primaryKey(),
    run_id: denTypeIdColumn("automationRun", "run_id").notNull(),
    attempt: int("attempt").notNull(),
    sequence: int("sequence").notNull(),
    engine_event_id: varchar("engine_event_id", { length: 240 }),
    engine_idempotency_key: varchar("engine_idempotency_key", { length: 512 }),
    engine_execution_id: varchar("engine_execution_id", { length: 240 }),
    event_type: mysqlEnum("event_type", runEventTypes).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("automation_run_event_sequence").on(table.run_id, table.attempt, table.sequence),
    uniqueIndex("automation_run_engine_event").on(table.run_id, table.engine_idempotency_key),
    index("automation_run_event_created").on(table.run_id, table.attempt, table.created_at),
  ],
)

export const automationRelations = relations(AutomationTable, ({ one, many }) => ({
  currentRevision: one(AutomationRevisionTable, {
    fields: [AutomationTable.current_revision_id],
    references: [AutomationRevisionTable.id],
  }),
  revisions: many(AutomationRevisionTable),
  runs: many(AutomationRunTable),
}))

export const automationRevisionRelations = relations(AutomationRevisionTable, ({ one, many }) => ({
  automation: one(AutomationTable, {
    fields: [AutomationRevisionTable.automation_id],
    references: [AutomationTable.id],
  }),
  runs: many(AutomationRunTable),
}))

export const automationRunRelations = relations(AutomationRunTable, ({ one, many }) => ({
  automation: one(AutomationTable, {
    fields: [AutomationRunTable.automation_id],
    references: [AutomationTable.id],
  }),
  revision: one(AutomationRevisionTable, {
    fields: [AutomationRunTable.revision_id],
    references: [AutomationRevisionTable.id],
  }),
  events: many(AutomationRunEventTable),
}))

export const automationRunEventRelations = relations(AutomationRunEventTable, ({ one }) => ({
  run: one(AutomationRunTable, {
    fields: [AutomationRunEventTable.run_id],
    references: [AutomationRunTable.id],
  }),
}))
