// Offline Drizzle serialization only: no environment loading, DB client or SQL execution.
// pnpm exec node --conditions=development --import tsx scripts/generate-gateway-universe-metadata.mjs
import { readFile, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import * as schema from "../src/schema.ts"

const meta = new URL("../drizzle/meta/", import.meta.url)
const previous = JSON.parse(await readFile(new URL("0097_snapshot.json", meta), "utf8"))
const journalPath = new URL("_journal.json", meta)
const journalSource = await readFile(journalPath, "utf8")
const journal = JSON.parse(journalSource)
const last = journal.entries.at(-1)
if (last?.idx !== 97 || last.tag !== "0097_gateway_access_matrix") {
  throw new Error("Expected registered 0097; refusing to overwrite migration history")
}
const tag = "0098_gateway_provider_model_universe"
await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8")
const snapshot = JSON.parse(JSON.stringify(await generateMySQLDrizzleJson(schema, previous.id)))
const expected = structuredClone(previous)
expected.id = snapshot.id
expected.prevId = previous.id
expected.tables.gateway_providers.columns.model_ids = {
  name: "model_ids", type: "json", primaryKey: false, notNull: true,
  autoincrement: false, default: "(JSON_ARRAY())",
}
if (!isDeepStrictEqual(expected, snapshot)) {
  throw new Error("Source delta is not exactly gateway_providers.model_ids; resolve unrelated drift separately")
}
const statements = await generateMySQLMigration(previous, snapshot)
if (statements.length !== 1 || !/^ALTER TABLE `gateway_providers` ADD `model_ids` json DEFAULT \(JSON_ARRAY\(\)\) NOT NULL;$/.test(statements[0])) {
  throw new Error(`Unexpected schema delta: ${JSON.stringify(statements)}`)
}
if (await readFile(journalPath, "utf8") !== journalSource) throw new Error("Journal changed during serialization")
await writeFile(new URL("0098_snapshot.json", meta), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" })
journal.entries.push({ idx: 98, version: snapshot.version, when: Math.max(Date.now(), last.when + 1), tag, breakpoints: true })
await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
console.log(`Registered ${tag}: version=${snapshot.version}; id=${snapshot.id}; prevId=${snapshot.prevId}`)
console.log(`Drizzle schema delta: ${statements[0]}`)
console.log("Execution SQL stages nullable ADD, selection backfill, then NOT NULL/default. No SQL executed; 0097 and unrelated snapshots unchanged.")
