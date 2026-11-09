import { boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import {
  CONFIG_CHANGE_REQUEST_SOURCES,
  CONFIG_CHANGE_REQUEST_STATUSES,
  CONFIG_IMPORT_MODES,
  type ConfigApplyReport,
  type ConfigAreaKey,
  type ConfigDecisions,
  type ConfigDeployment,
  type ConfigPlan,
  type ConfigSecretInput,
} from "@openwork/types/den/config-blobs"
import { compatJsonColumn, denTypeIdColumn, encryptedColumn, timestamps } from "../columns"

/**
 * Config blobs (docs/features/config-blobs/): org config export / import.
 * Blobs, plans and snapshots carry confidential content (skills, prompts), so
 * they are encrypted at rest. Secret inputs are encrypted and cleared after use.
 */
const encryptedJsonColumn = <TData>(name: string) => encryptedColumn<TData>(name, {
  dataType: "mediumtext",
  serialize: JSON.stringify,
  deserialize: JSON.parse,
})

export type ConfigChangeRequestApproval = { memberId: string; at: string }

/** One import of a blob into an organization: queued, analyzed, reviewed, applied. */
export const ConfigChangeRequestTable = mysqlTable(
  "config_change_request",
  {
    id: denTypeIdColumn("configChangeRequest", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    status: varchar("status", { length: 24, enum: CONFIG_CHANGE_REQUEST_STATUSES }).notNull().default("uploaded"),
    title: varchar("title", { length: 200 }),
    mode: varchar("mode", { length: 16, enum: CONFIG_IMPORT_MODES }).notNull().default("merge"),
    sourceKind: varchar("source_kind", { length: 16, enum: CONFIG_CHANGE_REQUEST_SOURCES }).notNull(),
    createdByMemberId: denTypeIdColumn("member", "created_by_member_id"),
    apiKeyId: varchar("api_key_id", { length: 64 }),
    apiKeyName: varchar("api_key_name", { length: 255 }),
    /** The uploaded blob as received. May be invalid (status `invalid`). */
    blob: encryptedJsonColumn<unknown>("blob").notNull(),
    sourceInstanceId: varchar("source_instance_id", { length: 100 }),
    sourceOrgId: varchar("source_org_id", { length: 100 }),
    sourceOrgSlug: varchar("source_org_slug", { length: 255 }),
    sourceOrgName: varchar("source_org_name", { length: 255 }),
    sourceDeployment: varchar("source_deployment", { length: 16 }).$type<ConfigDeployment>(),
    areas: compatJsonColumn<ConfigAreaKey[]>("areas").notNull(),
    baseHash: varchar("base_hash", { length: 80 }),
    plan: encryptedJsonColumn<ConfigPlan>("plan"),
    planHash: varchar("plan_hash", { length: 80 }),
    decisions: compatJsonColumn<ConfigDecisions>("decisions"),
    /** Write-only secret values and decisions; deleted after apply, cancel or expiry. */
    secretInputs: encryptedJsonColumn<ConfigSecretInput[]>("secret_inputs"),
    approvals: compatJsonColumn<ConfigChangeRequestApproval[]>("approvals").notNull(),
    approvedPlanHash: varchar("approved_plan_hash", { length: 80 }),
    autoApply: boolean("auto_apply").notNull().default(false),
    /** Export of the plan's scope taken just before apply: the revert source. */
    beforeSnapshot: encryptedJsonColumn<unknown>("before_snapshot"),
    report: compatJsonColumn<ConfigApplyReport>("report"),
    errors: compatJsonColumn<string[]>("errors").notNull(),
    leaseOwner: varchar("lease_owner", { length: 64 }),
    leaseUntil: timestamp("lease_until", { fsp: 3 }),
    availableAt: timestamp("available_at", { fsp: 3 }).notNull().defaultNow(),
    attempts: int("attempts").notNull().default(0),
    revertsChangeRequestId: denTypeIdColumn("configChangeRequest", "reverts_change_request_id"),
    revertedByChangeRequestId: denTypeIdColumn("configChangeRequest", "reverted_by_change_request_id"),
    appliedAt: timestamp("applied_at", { fsp: 3 }),
    createdAt: timestamps.created_at,
    updatedAt: timestamps.updated_at,
  },
  (table) => [
    index("config_change_request_org_status").on(table.organizationId, table.status),
    index("config_change_request_queue").on(table.status, table.availableAt),
  ],
)

/** A source item id (from another org or instance) that was created under a different local id. */
export const ConfigBlobAliasTable = mysqlTable(
  "config_blob_alias",
  {
    id: denTypeIdColumn("configBlobAlias", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    area: varchar("area", { length: 64 }).$type<ConfigAreaKey>().notNull(),
    sourceInstanceId: varchar("source_instance_id", { length: 100 }).notNull(),
    sourceId: varchar("source_id", { length: 100 }).notNull(),
    localId: varchar("local_id", { length: 100 }).notNull(),
    createdByChangeRequestId: denTypeIdColumn("configChangeRequest", "created_by_change_request_id"),
    createdAt: timestamps.created_at,
  },
  (table) => [
    uniqueIndex("config_blob_alias_source").on(table.organizationId, table.area, table.sourceInstanceId, table.sourceId),
  ],
)

/** Recent exports per org, keyed by `base_hash`: field-level base values for the three-way diff. */
export const ConfigBlobExportTable = mysqlTable(
  "config_blob_export",
  {
    id: denTypeIdColumn("configBlobExport", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    baseHash: varchar("base_hash", { length: 80 }).notNull(),
    areas: compatJsonColumn<ConfigAreaKey[]>("areas").notNull(),
    blob: encryptedJsonColumn<unknown>("blob").notNull(),
    createdAt: timestamps.created_at,
  },
  (table) => [index("config_blob_export_org_base").on(table.organizationId, table.baseHash)],
)
