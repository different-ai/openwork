import { relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import {
  INFERENCE_REQUEST_OUTCOMES,
  INFERENCE_REQUEST_PROTOCOLS,
  INFERENCE_REQUEST_ROUTES,
  INFERENCE_RESET_STRATEGIES,
  INFERENCE_ROLLUP_GRANULARITIES,
  INFERENCE_USAGE_SOURCES,
  INFERENCE_WINDOW_TYPES,
} from "@openwork/types/den/inference"
import { compatJsonColumn, denTypeIdColumn, encryptedTextColumn, timestamps } from "../columns"
import { InferenceProviderCredentialTable, InferenceProviderTable } from "./inference-providers"
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
export const InferenceRequestLogTable = mysqlTable(
  "inference_request_logs",
  {
    id: denTypeIdColumn("inferenceRequestLog", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    inference_key_id: denTypeIdColumn("inferenceKey", "inference_key_id").notNull(),
    inference_provider_id: denTypeIdColumn("inferenceProvider", "inference_provider_id"),
    inference_provider_credential_id: denTypeIdColumn(
      "inferenceProviderCredential",
      "inference_provider_credential_id",
    ),
    route: mysqlEnum("route", INFERENCE_REQUEST_ROUTES).notNull(),
    protocol: mysqlEnum("protocol", INFERENCE_REQUEST_PROTOCOLS).notNull(),
    upstream_provider_id: varchar("upstream_provider_id", { length: 64 }).notNull(),
    upstream_host: varchar("upstream_host", { length: 255 }).notNull(),
    upstream_path: varchar("upstream_path", { length: 512 }).notNull(),
    method: varchar("method", { length: 8 }).notNull(),
    requested_model: varchar("requested_model", { length: 255 }),
    upstream_model: varchar("upstream_model", { length: 255 }),
    stream: boolean("stream").notNull(),
    status: smallint("status"),
    outcome: mysqlEnum("outcome", INFERENCE_REQUEST_OUTCOMES).notNull(),
    error_code: varchar("error_code", { length: 64 }),
    input_tokens: int("input_tokens"),
    output_tokens: int("output_tokens"),
    total_tokens: int("total_tokens"),
    cache_read_tokens: int("cache_read_tokens"),
    cache_write_tokens: int("cache_write_tokens"),
    reasoning_tokens: int("reasoning_tokens"),
    usage_source: mysqlEnum("usage_source", INFERENCE_USAGE_SOURCES).notNull(),
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
    uniqueIndex("inference_request_logs_openwork_request_id").on(table.openwork_request_id),
    index("inference_request_logs_org_started").on(table.organization_id, table.started_at),
    index("inference_request_logs_member_started").on(table.org_membership_id, table.started_at),
    index("inference_request_logs_provider_started").on(
      table.inference_provider_id,
      table.started_at,
    ),
    index("inference_request_logs_started_at").on(table.started_at),
  ],
)

// Hour/day aggregates of inference_request_logs, one row per dimension combination per bucket.
export const InferenceUsageRollupTable = mysqlTable(
  "inference_usage_rollups",
  {
    id: denTypeIdColumn("inferenceUsageRollup", "id").notNull().primaryKey(),
    granularity: mysqlEnum("granularity", INFERENCE_ROLLUP_GRANULARITIES).notNull(),
    bucket_start: timestamp("bucket_start", { fsp: 3 }).notNull(),
    // MySQL unique indexes treat NULL as distinct, so a unique index over the
    // dimension columns would not dedupe rows where inference_provider_id or
    // upstream_model is null. The app computes the sha256 hex (64 chars) of the
    // joined dimension values and the unique key is (granularity, bucket_start,
    // dimension_key) so the rollup upsert stays idempotent.
    dimension_key: varchar("dimension_key", { length: 64 }).notNull(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    inference_provider_id: denTypeIdColumn("inferenceProvider", "inference_provider_id"),
    route: mysqlEnum("route", INFERENCE_REQUEST_ROUTES).notNull(),
    protocol: mysqlEnum("protocol", INFERENCE_REQUEST_PROTOCOLS).notNull(),
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
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inference_usage_rollups_bucket_dimension").on(
      table.granularity,
      table.bucket_start,
      table.dimension_key,
    ),
    index("inference_usage_rollups_org_granularity_bucket").on(
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

export const inferenceRequestLogRelations = relations(InferenceRequestLogTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [InferenceRequestLogTable.organization_id],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [InferenceRequestLogTable.org_membership_id],
    references: [MemberTable.id],
  }),
  inferenceKey: one(InferenceKeyTable, {
    fields: [InferenceRequestLogTable.inference_key_id],
    references: [InferenceKeyTable.id],
  }),
  inferenceProvider: one(InferenceProviderTable, {
    fields: [InferenceRequestLogTable.inference_provider_id],
    references: [InferenceProviderTable.id],
  }),
  inferenceProviderCredential: one(InferenceProviderCredentialTable, {
    fields: [InferenceRequestLogTable.inference_provider_credential_id],
    references: [InferenceProviderCredentialTable.id],
  }),
}))

export const inferenceUsageRollupRelations = relations(InferenceUsageRollupTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [InferenceUsageRollupTable.organization_id],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [InferenceUsageRollupTable.org_membership_id],
    references: [MemberTable.id],
  }),
  inferenceProvider: one(InferenceProviderTable, {
    fields: [InferenceUsageRollupTable.inference_provider_id],
    references: [InferenceProviderTable.id],
  }),
}))

export const inferenceKey = InferenceKeyTable
export const inferenceOrgLimitPolicy = InferenceOrgLimitPolicyTable
export const inferenceOrgUsageBucket = InferenceOrgUsageBucketTable
export const inferenceOrgUpstreamProviderKey = InferenceOrgUpstreamProviderKeyTable
export const inferenceUsageLedgerEntry = InferenceUsageLedgerEntryTable
export const inferenceUsageLedgerBucketCharge = InferenceUsageLedgerBucketChargeTable
export const inferenceRequestLog = InferenceRequestLogTable
export const inferenceUsageRollup = InferenceUsageRollupTable
