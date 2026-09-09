// Offline serializer only. No environment loading, DB driver or migration execution.
// Run with: pnpm exec node --conditions=development --import tsx scripts/generate-gateway-matrix-metadata.mjs
import { readFile, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import * as schema from "../src/schema.ts"

const meta = new URL("../drizzle/meta/", import.meta.url)
const previous = JSON.parse(await readFile(new URL("0094_snapshot.json", meta), "utf8"))
const journalPath = new URL("_journal.json", meta)
const journalSource = await readFile(journalPath, "utf8")
const journal = JSON.parse(journalSource)
// Compare the actual serialized representation, not optional undefined fields
// present only in the serializer's in-memory objects.
const snapshot = JSON.parse(JSON.stringify(await generateMySQLDrizzleJson(schema, previous.id)))
const renames = [
  ["inference_providers", "gateway_providers"],
  ["inference_provider_models", "gateway_provider_models"],
  ["inference_provider_credentials", "gateway_provider_credentials"],
  ["inference_provider_access", "gateway_provider_access"],
  ["inference_provider_oauth_states", "gateway_provider_oauth_states"],
  ["inference_request_logs", "gateway_request_logs"],
  ["inference_usage_rollups", "gateway_usage_rollups"],
  ["inference_rollup_lock", "gateway_rollup_lock"],
]
const newTables = ["gateway_keys", "gateway_model_groups", "gateway_model_group_models", "gateway_credential_sets"]
const removed = new Set(renames.map(([before]) => before))
const added = new Set([...renames.map(([, after]) => after), ...newTables])

if (snapshot.version !== previous.version || snapshot.dialect !== previous.dialect) {
  throw new Error("Unexpected snapshot format change; do not rewrite migration history")
}
for (const [name, table] of Object.entries(previous.tables)) {
  if (removed.has(name)) {
    if (snapshot.tables[name]) throw new Error(`Old Gateway table still exported: ${name}`)
  } else if (!isDeepStrictEqual(table, snapshot.tables[name])) {
    for (const key of new Set([...Object.keys(table), ...Object.keys(snapshot.tables[name] ?? {})])) {
      if (!isDeepStrictEqual(table[key], snapshot.tables[name]?.[key])) {
        console.log(JSON.stringify({ table: name, field: key, previous: table[key], current: snapshot.tables[name]?.[key] }, null, 2))
      }
    }
    throw new Error(`Unrelated schema drift at ${name}; resolve separately before registering 0095`)
  }
}
for (const name of Object.keys(snapshot.tables)) {
  if (!previous.tables[name] && !added.has(name)) throw new Error(`Unexpected new table: ${name}`)
}
for (const name of added) {
  if (!snapshot.tables[name]) throw new Error(`Missing Gateway table: ${name}`)
}
if (!isDeepStrictEqual(previous.views, snapshot.views)) throw new Error("Unrelated view drift")

const tag = "0095_gateway_access_matrix"
const snapshotPath = new URL("0095_snapshot.json", meta)
if (process.argv.includes("--schema-delta")) {
  // In-memory comparison only: account for explicit data-preserving renames so
  // Kit never prompts or suggests DROP/CREATE for a table holding existing rows.
  const renamedPrevious = structuredClone(previous)
  for (const [before, after] of renames) {
    const table = renamedPrevious.tables[before]
    delete renamedPrevious.tables[before]
    renamedPrevious.tables[after] = table
    table.name = after
    const columns = {
      inference_provider_id: "gateway_provider_id",
      inference_provider_credential_id: "gateway_provider_credential_id",
    }
    for (const [oldColumn, newColumn] of Object.entries(columns)) {
      if (!table.columns[oldColumn]) continue
      table.columns[newColumn] = { ...table.columns[oldColumn], name: newColumn }
      delete table.columns[oldColumn]
    }
    for (const [name, index] of Object.entries(table.indexes)) {
      index.columns = index.columns.map((column) => columns[column] ?? column)
      const canonicalName = name.replace(/^inference_/, "gateway_")
      if (snapshot.tables[after].indexes[canonicalName]) {
        table.indexes[canonicalName] = { ...index, name: canonicalName }
        delete table.indexes[name]
      }
    }
    // MySQL's primary index remains PRIMARY; Kit's table-derived label changes.
    for (const [name, primary] of Object.entries(table.compositePrimaryKeys)) {
      const canonicalName = name.replace(/^inference_/, "gateway_")
      table.compositePrimaryKeys[canonicalName] = { ...primary, name: canonicalName }
      delete table.compositePrimaryKeys[name]
    }
  }
  const statements = await generateMySQLMigration(renamedPrevious, snapshot)
  if (statements.some((statement) => /DROP TABLE|DROP PRIMARY KEY|DROP COLUMN/i.test(statement))) {
    throw new Error("Unexpected destructive schema delta after explicit renames")
  }
  console.log("Schema-only reference delta after the eight explicit renames (NOT execution SQL; staged backfills remain in 0095):")
  console.log(statements.join("\n"))
} else if (process.argv.includes("--check")) {
  const saved = JSON.parse(await readFile(snapshotPath, "utf8"))
  const { id: _generatedId, ...generatedShape } = snapshot
  const { id: _savedId, ...savedShape } = saved
  if (!isDeepStrictEqual(generatedShape, savedShape)) throw new Error("0095 snapshot no longer matches current source")
  if (journal.entries.at(-1)?.tag !== tag || journal.entries.at(-1)?.idx !== 95) {
    throw new Error("0095 is not the last registered migration")
  }
  console.log(`0095 source snapshot matches: ${Object.keys(saved.tables).length} tables; prevId=${saved.prevId}`)
} else {
  const last = journal.entries.at(-1)
  if (last?.idx !== 94 || last.tag !== "0094_inference_accounting_observations") {
    throw new Error("Journal moved beyond 0094; refusing to overwrite concurrent migration metadata")
  }
  if (await readFile(journalPath, "utf8") !== journalSource) throw new Error("Journal changed during serialization")
  const entry = { idx: 95, version: snapshot.version, when: Math.max(Date.now(), last.when + 1), tag, breakpoints: true }
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" })
  journal.entries.push(entry)
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  console.log(`Registered ${tag}: ${Object.keys(snapshot.tables).length} serialized tables; id=${snapshot.id}; prevId=${snapshot.prevId}`)
  console.log("Eight table renames and four new tables; all unrelated table/view snapshots unchanged. No SQL executed.")
}
