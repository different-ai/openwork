import { relations } from "drizzle-orm"
import {
  bigint,
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { INFERENCE_RESET_STRATEGIES, INFERENCE_WINDOW_TYPES } from "@openwork/types/den/inference"
import { denTypeIdColumn, encryptedTextColumn, timestamps } from "../columns"
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
    index("inference_org_limit_policies_organization_id").on(table.organization_id),
    uniqueIndex("inference_org_limit_policies_org_window_type").on(
      table.organization_id,
      table.window_type,
    ),
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
    index("inference_org_usage_buckets_policy_id").on(table.policy_id),
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
    index("inference_org_upstream_provider_keys_organization_id").on(table.organization_id),
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

export const inferenceKey = InferenceKeyTable
export const inferenceOrgLimitPolicy = InferenceOrgLimitPolicyTable
export const inferenceOrgUsageBucket = InferenceOrgUsageBucketTable
export const inferenceOrgUpstreamProviderKey = InferenceOrgUpstreamProviderKeyTable
export const inferenceUsageLedgerEntry = InferenceUsageLedgerEntryTable
export const inferenceUsageLedgerBucketCharge = InferenceUsageLedgerBucketChargeTable
