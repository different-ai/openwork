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

async function ensureOrgDefaultModelTeamIndex(executor: Executor) {
  const tableName = "org_default_model"
  const indexName = "org_default_model_team_id"
  if (!(await tableExists(executor, tableName))) {
    return
  }
  // 0145 once created the table and index in separate statements; a database
  // that kept the table after the index failed is missing this index.
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [tableName, indexName],
  )
  if (rows.length > 0) {
    return
  }
  await runDdl(executor, `CREATE INDEX \`${indexName}\` ON \`${tableName}\` (\`team_id\`)`)
  console.log(`[den-db] ${tableName}.team_id index created`)
}

async function indexExists(executor: Executor, table: string, indexName: string) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  )
  return rows.length > 0
}

async function columnExists(executor: Executor, table: string, column: string) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

/**
 * 0179 once created session_sso_proof, added deviceCode.sso_authenticated_at
 * and then the indexes in separate statements. Production's first run stopped
 * after the column; 0179 now only creates the table (with its indexes) and
 * copies rows, so the column lives here and so do the indexes a table from
 * that first run is missing.
 */
async function ensureSessionSsoProofSchema(executor: Executor) {
  if (await tableExists(executor, "deviceCode") && !(await columnExists(executor, "deviceCode", "sso_authenticated_at"))) {
    await runDdl(executor, "ALTER TABLE `deviceCode` ADD `sso_authenticated_at` timestamp(3)")
    console.log("[den-db] deviceCode.sso_authenticated_at column added")
  }
  if (!(await tableExists(executor, "session_sso_proof"))) {
    return
  }
  for (const [indexName, column] of [["session_sso_proof_org", "organization_id"], ["session_sso_proof_user", "user_id"]] as const) {
    if (await indexExists(executor, "session_sso_proof", indexName)) continue
    await runDdl(executor, `CREATE INDEX \`${indexName}\` ON \`session_sso_proof\` (\`${column}\`)`)
    console.log(`[den-db] session_sso_proof.${column} index created`)
  }
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
  await ensureOrgDefaultModelTeamIndex(executor)
  await ensureSessionSsoProofSchema(executor)
}
