import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { normalizeDesktopAppRestrictions } from "@openwork/types/den/desktop-app-restrictions"
import type { DesktopPolicyValue } from "@openwork/types/den/desktop-policies"

export type Executor = {
  query: (sql: string, args?: (string | number)[]) => Promise<Record<string, unknown>[]>
}

type OrganizationRepair = {
  table: string
  parentTable: string
  foreignKey: string
}

type ColumnNullability = "YES" | "NO"

export const ORGANIZATION_REPAIRS: OrganizationRepair[] = [
  { table: "config_object_version", parentTable: "config_object", foreignKey: "config_object_id" },
  { table: "config_object_access_grant", parentTable: "config_object", foreignKey: "config_object_id" },
  { table: "plugin_config_object", parentTable: "plugin", foreignKey: "plugin_id" },
  { table: "plugin_access_grant", parentTable: "plugin", foreignKey: "plugin_id" },
  { table: "connector_instance_access_grant", parentTable: "connector_instance", foreignKey: "connector_instance_id" },
  { table: "connector_target", parentTable: "connector_instance", foreignKey: "connector_instance_id" },
  { table: "connector_mapping", parentTable: "connector_instance", foreignKey: "connector_instance_id" },
  { table: "connector_sync_event", parentTable: "connector_instance", foreignKey: "connector_instance_id" },
  { table: "connector_source_binding", parentTable: "connector_instance", foreignKey: "connector_instance_id" },
  { table: "connector_source_tombstone", parentTable: "connector_instance", foreignKey: "connector_instance_id" },
]

function quoteIdentifier(identifier: string) {
  return `\`${identifier.replace(/`/g, "``")}\``
}

function numericValue(rows: Record<string, unknown>[], column: string) {
  const value = rows[0]?.[column]
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "bigint") {
    return Number(value)
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function messageFromUnknown(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") {
      return message
    }
  }
  return String(error)
}

function suggestsPlanetScaleSafeMigrations(message: string) {
  const lower = message.toLowerCase()
  return lower.includes("safe migration") || lower.includes("safe-migration") || lower.includes("direct ddl")
}

async function runDdl(executor: Executor, sql: string) {
  try {
    await executor.query(sql)
  } catch (error) {
    const message = messageFromUnknown(error)
    if (suggestsPlanetScaleSafeMigrations(message)) {
      throw new Error(
        `${message}\n[den-db] Schema repair DDL was blocked by PlanetScale safe migrations. ` +
          "Disable safe-migrations or apply the change via a deploy request, then re-run the schema repair step.",
        { cause: error },
      )
    }
    throw error
  }
}

async function tableExists(executor: Executor, table: string) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.TABLES
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  )
  return rows.length > 0
}

async function organizationColumnNullability(executor: Executor, table: string): Promise<ColumnNullability | undefined> {
  const rows = await executor.query(
    `SELECT is_nullable AS is_nullable FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'organization_id' LIMIT 1`,
    [table],
  )
  const isNullable = rows[0]?.is_nullable
  if (isNullable === "YES" || isNullable === "NO") {
    return isNullable
  }
  if (isNullable === undefined) {
    return undefined
  }
  throw new Error(`Unexpected organization_id nullability for ${table}: ${String(isNullable)}`)
}

async function organizationIndexExists(executor: Executor, table: string) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, `${table}_organization_id`],
  )
  return rows.length > 0
}

async function backfillAndRequireOrganizationColumn(executor: Executor, repair: OrganizationRepair) {
  const table = quoteIdentifier(repair.table)
  const parentTable = quoteIdentifier(repair.parentTable)
  const foreignKey = quoteIdentifier(repair.foreignKey)

  await executor.query(
    `UPDATE ${table} child_table
     JOIN ${parentTable} parent_table ON child_table.${foreignKey} = parent_table.\`id\`
     SET child_table.\`organization_id\` = parent_table.\`organization_id\`
     WHERE child_table.\`organization_id\` IS NULL`,
  )
  console.log(`[den-db] ${repair.table}.organization_id backfilled from ${repair.parentTable}`)

  const nullRows = await executor.query(`SELECT COUNT(*) AS null_count FROM ${table} WHERE \`organization_id\` IS NULL`)
  if (numericValue(nullRows, "null_count") > 0) {
    const orphanRows = await executor.query(
      `SELECT child_table.\`id\` AS id FROM ${table} child_table
       LEFT JOIN ${parentTable} parent_table ON child_table.${foreignKey} = parent_table.\`id\`
       WHERE child_table.\`organization_id\` IS NULL
       LIMIT 20`,
    )
    const orphanIds = orphanRows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string")
    throw new Error(
      `Unable to backfill ${repair.table}.organization_id; orphan ids: ${orphanIds.join(", ")}`,
    )
  }

  await runDdl(executor, `ALTER TABLE ${table} MODIFY \`organization_id\` varchar(64) NOT NULL`)
  console.log(`[den-db] ${repair.table}.organization_id made NOT NULL`)
}

async function repairOrganizationColumn(executor: Executor, repair: OrganizationRepair) {
  const table = quoteIdentifier(repair.table)

  const countRows = await executor.query(`SELECT COUNT(*) AS row_count FROM ${table}`)
  if (numericValue(countRows, "row_count") === 0) {
    await runDdl(executor, `ALTER TABLE ${table} ADD COLUMN \`organization_id\` varchar(64) NOT NULL AFTER \`id\``)
    console.log(`[den-db] ${repair.table}.organization_id column added`)
    return
  }

  await runDdl(executor, `ALTER TABLE ${table} ADD COLUMN \`organization_id\` varchar(64) NULL AFTER \`id\``)
  console.log(`[den-db] ${repair.table}.organization_id nullable column added`)
  await backfillAndRequireOrganizationColumn(executor, repair)
}

async function ensureOrganizationIndex(executor: Executor, tableName: string) {
  if (await organizationIndexExists(executor, tableName)) {
    return
  }
  const table = quoteIdentifier(tableName)
  const indexName = `${tableName}_organization_id`
  await runDdl(executor, `CREATE INDEX ${quoteIdentifier(indexName)} ON ${table} (\`organization_id\`)`)
  console.log(`[den-db] ${tableName}.organization_id index created`)
}

async function ensureInferenceOrgLimitAmountNullable(executor: Executor) {
  const tableName = "inference_org_limit_policies"
  if (!(await tableExists(executor, tableName))) {
    return
  }

  // 0015 briefly created a stale NOT NULL column that the current schema omits.
  // Existing DBs need it nullable so inserts can omit it without losing data.
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = 'limit_amount'
       AND is_nullable = 'NO'
       AND column_default IS NULL
     LIMIT 1`,
    [tableName],
  )
  if (rows.length === 0) {
    return
  }

  await runDdl(executor, `ALTER TABLE \`inference_org_limit_policies\` MODIFY \`limit_amount\` bigint NULL`)
  console.log("[den-db] inference_org_limit_policies.limit_amount made nullable")
}

const LEGACY_DEFAULT_DESKTOP_POLICY_NAME = "Default desktop policy"

async function columnExists(executor: Executor, table: string, column: string) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

function roleIncludesOwner(roleValue: unknown) {
  return typeof roleValue === "string" && roleValue.split(",").map((entry) => entry.trim()).includes("owner")
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function legacyRestrictionsToPolicy(value: unknown): DesktopPolicyValue {
  const restrictions = normalizeDesktopAppRestrictions(value)
  return {
    allowCustomProviders: restrictions.disallowNonCloudModels !== true,
    allowZenModel: restrictions.blockZenModel !== true,
    allowMultipleWorkspaces: restrictions.blockMultipleWorkspaces !== true,
  }
}

/**
 * Applies the legacy `organization.desktop_app_restrictions` column as a
 * default desktop policy, for organizations that never ran the retired
 * `backfill:desktop-policies` script. Idempotent: only organizations with no
 * default desktop policy row and at least one legacy restriction are touched,
 * and the created policy makes the next run skip them. The column is dropped
 * one release later (W0-P13 PR F); until then this runs on every migrate.
 */
export async function ensureLegacyDesktopRestrictionsBackfilled(executor: Executor): Promise<number> {
  if (!(await tableExists(executor, "desktop_policy")) || !(await columnExists(executor, "organization", "desktop_app_restrictions"))) {
    return 0
  }

  // Any is_default row, deleted or not, counts: desktop_policy_org_default is
  // unique on (organization_id, is_default), so a second default cannot exist.
  const candidates = await executor.query(
    `SELECT o.id AS id, o.desktop_app_restrictions AS restrictions
     FROM organization o
     WHERE JSON_LENGTH(o.desktop_app_restrictions) > 0
       AND NOT EXISTS (
         SELECT 1 FROM desktop_policy p WHERE p.organization_id = o.id AND p.is_default = 1
       )
     ORDER BY o.created_at ASC`,
  )

  let created = 0
  for (const candidate of candidates) {
    const organizationId = candidate.id
    if (typeof organizationId !== "string") continue
    const restrictions = parseJsonColumn(candidate.restrictions)
    if (Object.keys(normalizeDesktopAppRestrictions(restrictions)).length === 0) continue

    // Same owner choice as the retired script: the latest-created owner.
    const members = await executor.query(
      "SELECT id, role FROM member WHERE organization_id = ? ORDER BY created_at ASC",
      [organizationId],
    )
    let owner: Record<string, unknown> | undefined
    for (const member of members) {
      if (!owner || roleIncludesOwner(member.role)) owner = member
    }
    if (!owner || typeof owner.id !== "string" || !roleIncludesOwner(owner.role)) {
      console.warn(`[den-db] Skipping legacy desktop restrictions for organization ${organizationId}: owner member not found.`)
      continue
    }

    await executor.query(
      `INSERT INTO desktop_policy (id, organization_id, policy_name, is_default, is_enabled, policy, created_by_org_member_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, CAST(? AS JSON), ?, NOW(3), NOW(3))`,
      [createDenTypeId("desktopPolicy"), organizationId, LEGACY_DEFAULT_DESKTOP_POLICY_NAME, JSON.stringify(legacyRestrictionsToPolicy(restrictions)), owner.id],
    )
    created += 1
  }

  if (created > 0) {
    console.log(`[den-db] Created ${created} default desktop policies from legacy desktop app restrictions`)
  }
  return created
}

export async function ensureSchemaRepairs(executor: Executor): Promise<void> {
  for (const repair of ORGANIZATION_REPAIRS) {
    if (!(await tableExists(executor, repair.table))) {
      continue
    }

    const nullability = await organizationColumnNullability(executor, repair.table)
    if (!nullability) {
      await repairOrganizationColumn(executor, repair)
    } else if (nullability === "YES") {
      await backfillAndRequireOrganizationColumn(executor, repair)
    }

    await ensureOrganizationIndex(executor, repair.table)
  }

  await ensureInferenceOrgLimitAmountNullable(executor)
  await ensureLegacyDesktopRestrictionsBackfilled(executor)
}
