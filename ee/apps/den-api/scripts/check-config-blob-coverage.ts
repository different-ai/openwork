// Enforces the config-blobs guard rail (docs/features/config-blobs/plan.md):
// every org-scoped table in den-db is either owned by exactly one config area
// (`ConfigArea.tables` in src/config-blobs/registry.ts) or listed in
// src/config-blobs/excluded.ts with a reason. Never both.
//   pnpm --filter @openwork-ee/den-api config-blobs:coverage

function setEnvDefault(name: string, value: string) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

// Area adapters import den-api modules that validate env on import; nothing
// here touches the database.
setEnvDefault("OPENWORK_DEV_MODE", "1")
setEnvDefault("DB_MODE", "mysql")
setEnvDefault("DATABASE_URL", "mysql://root:password@127.0.0.1:3306/openwork_den")
setEnvDefault("DEN_DB_ENCRYPTION_KEY", "local-dev-db-encryption-key-please-change-1234567890")
setEnvDefault("BETTER_AUTH_SECRET", "local-dev-secret-not-for-production-use!!")
setEnvDefault("BETTER_AUTH_URL", "http://localhost:8790")

export {}

const ORG_COLUMNS = new Set(["organization_id", "org_id"])

async function main() {
  const schema = await import("@openwork-ee/den-db/schema")
  const { getTableConfig, MySqlTable } = await import("@openwork-ee/den-db/drizzle")
  const { CONFIG_AREAS } = await import("../src/config-blobs/registry.js")
  const { CONFIG_BLOB_EXCLUDED_TABLES, CONFIG_BLOB_ORG_SCOPED_CHILD_TABLES } = await import("../src/config-blobs/excluded.js")

  const allTables = new Set<string>()
  const orgScoped = new Set<string>(CONFIG_BLOB_ORG_SCOPED_CHILD_TABLES)
  for (const value of Object.values(schema)) {
    if (!(value instanceof MySqlTable)) continue
    const config = getTableConfig(value)
    allTables.add(config.name)
    if (config.columns.some((column) => ORG_COLUMNS.has(column.name))) orgScoped.add(config.name)
  }

  const owners = new Map<string, string[]>()
  for (const area of CONFIG_AREAS) {
    for (const table of area.tables) owners.set(table, [...(owners.get(table) ?? []), area.key])
  }
  const excluded = new Map(Object.entries(CONFIG_BLOB_EXCLUDED_TABLES))

  const failures = new Map<string, string[]>()
  const fail = (category: string, entry: string) => failures.set(category, [...(failures.get(category) ?? []), entry])

  for (const table of [...orgScoped].sort()) {
    const areaKeys = owners.get(table) ?? []
    if (areaKeys.length === 0 && !excluded.has(table)) fail("org-scoped tables neither owned by an area nor excluded", table)
    if (areaKeys.length > 0 && excluded.has(table)) fail("tables both owned by an area and excluded", `${table} (${areaKeys.join(", ")}; excluded: ${excluded.get(table)?.reason})`)
    if (areaKeys.length > 1) fail("tables owned by more than one area", `${table} (${areaKeys.join(", ")})`)
  }
  for (const table of [...owners.keys()].sort()) if (!allTables.has(table)) fail("area tables that do not exist in den-db", `${table} (${owners.get(table)?.join(", ")})`)
  for (const table of [...excluded.keys()].sort()) if (!allTables.has(table)) fail("excluded tables that do not exist in den-db", table)
  for (const table of CONFIG_BLOB_ORG_SCOPED_CHILD_TABLES) if (!allTables.has(table)) fail("child tables that do not exist in den-db", table)

  const reasons = new Map<string, number>()
  for (const { reason } of excluded.values()) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  console.log([
    `org-scoped tables: ${orgScoped.size}; areas: ${CONFIG_AREAS.length}; owned tables: ${owners.size}; excluded: ${excluded.size}`,
    `excluded by reason: ${[...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, total]) => `${reason}=${total}`).join(" ")}`,
  ].join("\n"))
  if (failures.size === 0) {
    console.log("config blob coverage: OK")
    return 0
  }
  let total = 0
  for (const [category, entries] of failures) {
    total += entries.length
    console.error(`\n${category} (${entries.length}):`)
    for (const entry of entries) console.error(`  ${entry}`)
  }
  console.error("\nAdd each table to the area that owns its config (ConfigArea.tables) or to src/config-blobs/excluded.ts with a reason.")
  console.error(`config blob coverage: FAILED (${total} problems in ${failures.size} categories)`)
  return 1
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(error)
  code = 1
}
// Area modules may open pools on import; exit explicitly.
process.exit(code)
