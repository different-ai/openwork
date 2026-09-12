import { relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import {
  INFERENCE_RESET_STRATEGIES,
  INFERENCE_WINDOW_TYPES,
} from "@openwork/types/den/inference"
import {
  GATEWAY_REQUEST_OUTCOMES,
  GATEWAY_REQUEST_PROTOCOLS,
  GATEWAY_REQUEST_ROUTES,
  GATEWAY_ROLLUP_GRANULARITIES,
  GATEWAY_USAGE_SOURCES,
} from "@openwork/types/den/gateway"
import { compatJsonColumn, denTypeIdColumn, encryptedTextColumn, timestamps } from "../columns"
import {
  GatewayCredentialSetTable,
  GatewayKeyTable,
  GatewayModelGroupTable,
  GatewayProviderAccessTable,
  GatewayProviderCredentialTable,
  GatewayProviderTable,
} from "./inference-providers"
import { MemberTable, OrganizationTable } from "./org"

export const InferenceKeyStatus = ["active", "revoked"] as const
export const InferenceOrgUpstreamProviderKeyStatus = ["active", "revoked"] as const

export const InferenceKeyTable = mysqlTable(
  "inference_keys",
  {
    id: denTypeIdColumn("inferenceKey", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    name: varchar("name", { length: 255 }),
    key_hash: varchar("key_hash", { length: 255 }).notNull(),
    key_prefix: varchar("key_prefix", { length: 32 }),
    // Raw `ow_inf_` key (encrypted) so den-api can hand it back to the member's
    // desktop without materializing an llm_provider row. Null on legacy rows.
    encrypted_key: encryptedTextColumn("encrypted_key"),
    status: mysqlEnum("status", InferenceKeyStatus).notNull().default("active"),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inference_keys_key_hash").on(table.key_hash),
    index("inference_keys_organization_id").on(table.organization_id),
    index("inference_keys_org_membership_id").on(table.org_membership_id),
    index("inference_keys_status").on(table.status),
  ],
)

export const InferenceOrgLimitPolicyTable = mysqlTable(
  "inference_org_limit_policies",
  {
    id: denTypeIdColumn("inferenceOrgLimitPolicy", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    window_type: mysqlEnum("window_type", INFERENCE_WINDOW_TYPES).notNull(),
    reset_strategy: mysqlEnum("reset_strategy", INFERENCE_RESET_STRATEGIES).notNull(),
    anchor_at: timestamp("anchor_at", { fsp: 3 }),
    current_bucket_id: denTypeIdColumn("inferenceOrgUsageBucket", "current_bucket_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inference_org_limit_policies_org_window_type").on(
      table.organization_id,
      table.window_type,
    ),
    index("inference_org_limit_policies_current_bucket_id").on(table.current_bucket_id),
  ],
)

export const InferenceOrgUsageBucketTable = mysqlTable(
  "inference_org_usage_buckets",
  {
    id: denTypeIdColumn("inferenceOrgUsageBucket", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    policy_id: denTypeIdColumn("inferenceOrgLimitPolicy", "policy_id").notNull(),
    window_start_at: timestamp("window_start_at", { fsp: 3 }).notNull(),
    window_end_at: timestamp("window_end_at", { fsp: 3 }).notNull(),
    limit_amount: bigint("limit_amount", { mode: "number" }).notNull(),
    used_amount: bigint("used_amount", { mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("inference_org_usage_buckets_org_window").on(
      table.organization_id,
      table.window_start_at,
      table.window_end_at,
    ),
    index("inference_org_usage_buckets_policy_window").on(
      table.policy_id,
      table.window_start_at,
      table.window_end_at,
    ),
  ],
)

// Stores organization-owned upstream provider credentials used by the inference proxy.
export const InferenceOrgUpstreamProviderKeyTable = mysqlTable(
  "inference_org_upstream_provider_keys",
  {
    id: denTypeIdColumn("inferenceOrgProviderKey", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    provider: varchar("provider", { length: 64 }).notNull().default("openrouter"),
    external_key_hash: varchar("external_key_hash", { length: 255 }),
    external_workspace_id: varchar("external_workspace_id", { length: 255 }),
    encrypted_api_key: encryptedTextColumn("encrypted_api_key").notNull(),
    key_prefix: varchar("key_prefix", { length: 32 }),
    status: mysqlEnum("status", InferenceOrgUpstreamProviderKeyStatus).notNull().default("active"),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("inference_org_upstream_provider_keys_external_key_hash").on(table.external_key_hash),
    uniqueIndex("inference_org_upstream_provider_keys_org_provider").on(
      table.organization_id,
      table.provider,
    ),
    index("inference_org_upstream_provider_keys_status").on(table.status),
  ],
)

export const InferenceUsageLedgerEntryTable = mysqlTable(
  "inference_usage_ledger_entries",
  {
    id: denTypeIdColumn("inferenceUsageLedgerEntry", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    inference_key_id: denTypeIdColumn("inferenceKey", "inference_key_id"),
    external_job_id: varchar("external_job_id", { length: 255 }).notNull(),
    external_event_id: varchar("external_event_id", { length: 255 }),
    cost_amount: bigint("cost_amount", { mode: "number" }).notNull(),
    model_id: varchar("model_id", { length: 255 }),
    provider_id: varchar("provider_id", { length: 255 }),
    input_tokens: int("input_tokens"),
    output_tokens: int("output_tokens"),
    total_tokens: int("total_tokens"),
    event_type: varchar("event_type", { length: 64 }).notNull(),
    provider_usage: json("provider_usage").$type<{
      source: "openrouter_otlp"
      status: "priced" | "unpriced"
      requestModel: string | null
      responseModel: string | null
      inputCost: number | null
      outputCost: number | null
      currency: string | null
    }>(),
    occurred_at: timestamp("occurred_at", { fsp: 3 }).notNull(),
    created_at: timestamps.created_at,
  },
  (table) => [
    index("inference_usage_ledger_entries_organization_id").on(table.organization_id),
    index("inference_usage_ledger_entries_org_membership_id").on(table.org_membership_id),
    index("inference_usage_ledger_entries_inference_key_id").on(table.inference_key_id),
    uniqueIndex("inference_usage_ledger_entries_external_event_id").on(table.external_event_id),
    uniqueIndex("inference_usage_ledger_entries_job_event_type").on(
      table.external_job_id,
      table.event_type,
    ),
  ],
)

export const InferenceUsageLedgerBucketChargeTable = mysqlTable(
  "inference_usage_ledger_bucket_charges",
  {
    id: denTypeIdColumn("inferenceUsageLedgerBucketCharge", "id").notNull().primaryKey(),
    ledger_entry_id: denTypeIdColumn("inferenceUsageLedgerEntry", "ledger_entry_id").notNull(),
    bucket_id: denTypeIdColumn("inferenceOrgUsageBucket", "bucket_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    created_at: timestamps.created_at,
  },
  (table) => [
    index("inference_usage_ledger_bucket_charges_bucket_id").on(table.bucket_id),
    uniqueIndex("inference_usage_ledger_bucket_charges_entry_bucket").on(
      table.ledger_entry_id,
      table.bucket_id,
    ),
  ],
)

// One row per proxied request (OpenWork/OpenRouter route and org-provider route).
// Never stores prompt or completion content.
// No team ID is recorded; team usage is grouped by current memberships.
export const GatewayRequestLogTable = mysqlTable(
  "gateway_request_logs",
  {
    id: denTypeIdColumn("inferenceRequestLog", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    inference_key_id: denTypeIdColumn("inferenceKey", "inference_key_id"),
    gateway_key_id: denTypeIdColumn("gatewayKey", "gateway_key_id"),
    gateway_provider_id: denTypeIdColumn("inferenceProvider", "gateway_provider_id"),
    gateway_provider_credential_id: denTypeIdColumn(
      "inferenceProviderCredential",
      "gateway_provider_credential_id",
    ),
    // Historical rows retain unknown selection, not invented default grants.
    model_group_id: denTypeIdColumn("gatewayModelGroup", "model_group_id"),
    credential_set_id: denTypeIdColumn("gatewayCredentialSet", "credential_set_id"),
    access_grant_id: denTypeIdColumn("inferenceProviderAccess", "access_grant_id"),
    route: mysqlEnum("route", GATEWAY_REQUEST_ROUTES).notNull(),
    protocol: mysqlEnum("protocol", GATEWAY_REQUEST_PROTOCOLS).notNull(),
    upstream_provider_id: varchar("upstream_provider_id", { length: 64 }).notNull(),
    upstream_host: varchar("upstream_host", { length: 255 }).notNull(),
    upstream_path: varchar("upstream_path", { length: 512 }).notNull(),
    method: varchar("method", { length: 8 }).notNull(),
    requested_model: varchar("requested_model", { length: 255 }),
    upstream_model: varchar("upstream_model", { length: 255 }),
    stream: boolean("stream").notNull(),
    status: smallint("status"),
    outcome: mysqlEnum("outcome", GATEWAY_REQUEST_OUTCOMES).notNull(),
    generation_outcome: mysqlEnum("generation_outcome", ["completed", "content_filtered", "refused", "length_limited", "tool_calls", "unknown"]).notNull().default("unknown"),
    provider_terminal_reason: mysqlEnum("provider_terminal_reason", ["stop", "length", "tool_calls", "content_filter", "end_turn", "stop_sequence", "max_tokens", "tool_use", "refusal", "completed", "incomplete", "max_output_tokens", "unknown"]).notNull().default("unknown"),
    error_code: varchar("error_code", { length: 64 }),
    input_tokens: int("input_tokens"),
    output_tokens: int("output_tokens"),
    total_tokens: int("total_tokens"),
    cache_read_tokens: int("cache_read_tokens"),
    cache_write_tokens: int("cache_write_tokens"),
    reasoning_tokens: int("reasoning_tokens"),
    usage_source: mysqlEnum("usage_source", GATEWAY_USAGE_SOURCES).notNull(),
    cost_micro_usd: bigint("cost_micro_usd", { mode: "number" }),
    upstream_request_id: varchar("upstream_request_id", { length: 255 }),
    openwork_request_id: varchar("openwork_request_id", { length: 32 }).notNull(),
    started_at: timestamp("started_at", { fsp: 3 }).notNull(),
    first_byte_at: timestamp("first_byte_at", { fsp: 3 }),
    completed_at: timestamp("completed_at", { fsp: 3 }),
    request_bytes: bigint("request_bytes", { mode: "number" }),
    response_bytes: bigint("response_bytes", { mode: "number" }),
    metadata: compatJsonColumn<Record<string, unknown>>("metadata"),
    created_at: timestamps.created_at,
  },
  (table) => [
    uniqueIndex("gateway_request_logs_openwork_request_id").on(table.openwork_request_id),
    index("gateway_request_logs_org_started").on(table.organization_id, table.started_at),
    index("gateway_request_logs_member_started").on(table.org_membership_id, table.started_at),
    index("gateway_request_logs_provider_started").on(
      table.gateway_provider_id,
      table.started_at,
    ),
    index("gateway_request_logs_started_at").on(table.started_at),
  ],
)

// A permanent singleton record: INSERT ... ON DUPLICATE KEY UPDATE holds an
// InnoDB exclusive lock through commit, coordinating hourly AND daily consumers.
export const GatewayRollupLockTable = mysqlTable("gateway_rollup_lock", {
  id: int("id").notNull().primaryKey(),
})

// Hour/day aggregates of gateway_request_logs, one row per dimension combination per bucket.
export const GatewayUsageRollupTable = mysqlTable(
  "gateway_usage_rollups",
  {
    id: denTypeIdColumn("inferenceUsageRollup", "id").notNull().primaryKey(),
    granularity: mysqlEnum("granularity", GATEWAY_ROLLUP_GRANULARITIES).notNull(),
    bucket_start: timestamp("bucket_start", { fsp: 3 }).notNull(),
    // New aggregation uses gatewayRollupDimensionKey, including group/set/grant.
    // Preserve old hashes and NULL selection dimensions as historical unknowns.
    dimension_key: varchar("dimension_key", { length: 64 }).notNull(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    gateway_provider_id: denTypeIdColumn("inferenceProvider", "gateway_provider_id"),
    model_group_id: denTypeIdColumn("gatewayModelGroup", "model_group_id"),
    credential_set_id: denTypeIdColumn("gatewayCredentialSet", "credential_set_id"),
    access_grant_id: denTypeIdColumn("inferenceProviderAccess", "access_grant_id"),
    route: mysqlEnum("route", GATEWAY_REQUEST_ROUTES).notNull(),
    protocol: mysqlEnum("protocol", GATEWAY_REQUEST_PROTOCOLS).notNull(),
    upstream_provider_id: varchar("upstream_provider_id", { length: 64 }).notNull(),
    upstream_model: varchar("upstream_model", { length: 255 }),
    request_count: int("request_count").notNull().default(0),
    ok_count: int("ok_count").notNull().default(0),
    error_count: int("error_count").notNull().default(0),
    aborted_count: int("aborted_count").notNull().default(0),
    stream_count: int("stream_count").notNull().default(0),
    usage_missing_count: int("usage_missing_count").notNull().default(0),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    total_tokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    cache_read_tokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cache_write_tokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    reasoning_tokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    cost_micro_usd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    latency_ms_sum: bigint("latency_ms_sum", { mode: "number" }).notNull().default(0),
    ttfb_ms_sum: bigint("ttfb_ms_sum", { mode: "number" }).notNull().default(0),
    request_bytes: bigint("request_bytes", { mode: "number" }).notNull().default(0),
    response_bytes: bigint("response_bytes", { mode: "number" }).notNull().default(0),
    source_row_count: int("source_row_count").notNull().default(0),
    // NULL means an older rollup whose observation counts cannot be recovered.
    // New batches explicitly write zero when the measurement was not observed.
    input_tokens_count: bigint("input_tokens_count", { mode: "number" }),
    output_tokens_count: bigint("output_tokens_count", { mode: "number" }),
    total_tokens_count: bigint("total_tokens_count", { mode: "number" }),
    cache_read_tokens_count: bigint("cache_read_tokens_count", { mode: "number" }),
    cache_write_tokens_count: bigint("cache_write_tokens_count", { mode: "number" }),
    reasoning_tokens_count: bigint("reasoning_tokens_count", { mode: "number" }),
    cost_count: bigint("cost_count", { mode: "number" }),
    latency_count: bigint("latency_count", { mode: "number" }),
    ttfb_count: bigint("ttfb_count", { mode: "number" }),
    request_bytes_count: bigint("request_bytes_count", { mode: "number" }),
    response_bytes_count: bigint("response_bytes_count", { mode: "number" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("gateway_usage_rollups_bucket_dimension").on(
      table.granularity,
      table.bucket_start,
      table.dimension_key,
    ),
    index("gateway_usage_rollups_org_granularity_bucket").on(
      table.organization_id,
      table.granularity,
      table.bucket_start,
    ),
  ],
)

export const inferenceKeyRelations = relations(InferenceKeyTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [InferenceKeyTable.organization_id],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [InferenceKeyTable.org_membership_id],
    references: [MemberTable.id],
  }),
  ledgerEntries: many(InferenceUsageLedgerEntryTable),
}))

export const inferenceOrgLimitPolicyRelations = relations(
  InferenceOrgLimitPolicyTable,
  ({ many, one }) => ({
    organization: one(OrganizationTable, {
      fields: [InferenceOrgLimitPolicyTable.organization_id],
      references: [OrganizationTable.id],
    }),
    buckets: many(InferenceOrgUsageBucketTable),
  }),
)

export const inferenceOrgUsageBucketRelations = relations(
  InferenceOrgUsageBucketTable,
  ({ many, one }) => ({
    organization: one(OrganizationTable, {
      fields: [InferenceOrgUsageBucketTable.organization_id],
      references: [OrganizationTable.id],
    }),
    policy: one(InferenceOrgLimitPolicyTable, {
      fields: [InferenceOrgUsageBucketTable.policy_id],
      references: [InferenceOrgLimitPolicyTable.id],
    }),
    charges: many(InferenceUsageLedgerBucketChargeTable),
  }),
)

export const inferenceOrgUpstreamProviderKeyRelations = relations(
  InferenceOrgUpstreamProviderKeyTable,
  ({ one }) => ({
    organization: one(OrganizationTable, {
      fields: [InferenceOrgUpstreamProviderKeyTable.organization_id],
      references: [OrganizationTable.id],
    }),
  }),
)

export const inferenceUsageLedgerEntryRelations = relations(
  InferenceUsageLedgerEntryTable,
  ({ many, one }) => ({
    organization: one(OrganizationTable, {
      fields: [InferenceUsageLedgerEntryTable.organization_id],
      references: [OrganizationTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [InferenceUsageLedgerEntryTable.org_membership_id],
      references: [MemberTable.id],
    }),
    inferenceKey: one(InferenceKeyTable, {
      fields: [InferenceUsageLedgerEntryTable.inference_key_id],
      references: [InferenceKeyTable.id],
    }),
    bucketCharges: many(InferenceUsageLedgerBucketChargeTable),
  }),
)

export const inferenceUsageLedgerBucketChargeRelations = relations(
  InferenceUsageLedgerBucketChargeTable,
  ({ one }) => ({
    ledgerEntry: one(InferenceUsageLedgerEntryTable, {
      fields: [InferenceUsageLedgerBucketChargeTable.ledger_entry_id],
      references: [InferenceUsageLedgerEntryTable.id],
    }),
    bucket: one(InferenceOrgUsageBucketTable, {
      fields: [InferenceUsageLedgerBucketChargeTable.bucket_id],
      references: [InferenceOrgUsageBucketTable.id],
    }),
  }),
)

export const gatewayRequestLogRelations = relations(GatewayRequestLogTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [GatewayRequestLogTable.organization_id],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [GatewayRequestLogTable.org_membership_id],
    references: [MemberTable.id],
  }),
  inferenceKey: one(InferenceKeyTable, {
    fields: [GatewayRequestLogTable.inference_key_id],
    references: [InferenceKeyTable.id],
  }),
  gatewayKey: one(GatewayKeyTable, {
    fields: [GatewayRequestLogTable.gateway_key_id],
    references: [GatewayKeyTable.id],
  }),
  gatewayProvider: one(GatewayProviderTable, {
    fields: [GatewayRequestLogTable.gateway_provider_id],
    references: [GatewayProviderTable.id],
  }),
  gatewayProviderCredential: one(GatewayProviderCredentialTable, {
    fields: [GatewayRequestLogTable.gateway_provider_credential_id],
    references: [GatewayProviderCredentialTable.id],
  }),
  modelGroup: one(GatewayModelGroupTable, {
    fields: [GatewayRequestLogTable.model_group_id],
    references: [GatewayModelGroupTable.id],
  }),
  credentialSet: one(GatewayCredentialSetTable, {
    fields: [GatewayRequestLogTable.credential_set_id],
    references: [GatewayCredentialSetTable.id],
  }),
  accessGrant: one(GatewayProviderAccessTable, {
    fields: [GatewayRequestLogTable.access_grant_id],
    references: [GatewayProviderAccessTable.id],
  }),
}))

export const gatewayUsageRollupRelations = relations(GatewayUsageRollupTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [GatewayUsageRollupTable.organization_id],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [GatewayUsageRollupTable.org_membership_id],
    references: [MemberTable.id],
  }),
  gatewayProvider: one(GatewayProviderTable, {
    fields: [GatewayUsageRollupTable.gateway_provider_id],
    references: [GatewayProviderTable.id],
  }),
  modelGroup: one(GatewayModelGroupTable, {
    fields: [GatewayUsageRollupTable.model_group_id],
    references: [GatewayModelGroupTable.id],
  }),
  credentialSet: one(GatewayCredentialSetTable, {
    fields: [GatewayUsageRollupTable.credential_set_id],
    references: [GatewayCredentialSetTable.id],
  }),
  accessGrant: one(GatewayProviderAccessTable, {
    fields: [GatewayUsageRollupTable.access_grant_id],
    references: [GatewayProviderAccessTable.id],
  }),
}))

export const inferenceKey = InferenceKeyTable
export const inferenceOrgLimitPolicy = InferenceOrgLimitPolicyTable
export const inferenceOrgUsageBucket = InferenceOrgUsageBucketTable
export const inferenceOrgUpstreamProviderKey = InferenceOrgUpstreamProviderKeyTable
export const inferenceUsageLedgerEntry = InferenceUsageLedgerEntryTable
export const inferenceUsageLedgerBucketCharge = InferenceUsageLedgerBucketChargeTable
export const gatewayRequestLog = GatewayRequestLogTable
export const gatewayUsageRollup = GatewayUsageRollupTable
export const gatewayRollupLock = GatewayRollupLockTable

export {
  GatewayRequestLogTable as InferenceRequestLogTable,
  GatewayUsageRollupTable as InferenceUsageRollupTable,
  GatewayRollupLockTable as InferenceRollupLockTable,
  gatewayRequestLog as inferenceRequestLog,
  gatewayUsageRollup as inferenceUsageRollup,
}
