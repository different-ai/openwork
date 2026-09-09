// Offline Drizzle serialization only: no environment loading, DB client or SQL execution.
// pnpm exec node --conditions=development --import tsx scripts/generate-gateway-set-creator-metadata.mjs
import { readFile, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import * as schema from "../src/schema.ts"

const meta = new URL("../drizzle/meta/", import.meta.url)
const previous = JSON.parse(await readFile(new URL("0096_snapshot.json", meta), "utf8"))
const journalPath = new URL("_journal.json", meta)
const journalSource = await readFile(journalPath, "utf8")
const journal = JSON.parse(journalSource)
const last = journal.entries.at(-1)
if (last?.idx !== 96 || last.tag !== "0096_gateway_provider_model_universe") {
  throw new Error("Expected registered 0096; refusing to overwrite migration history")
}
const tag = "0097_gateway_credential_set_creator"
const sql = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8")
const snapshot = JSON.parse(JSON.stringify(await generateMySQLDrizzleJson(schema, previous.id)))
const expected = structuredClone(previous)
expected.id = snapshot.id
expected.prevId = previous.id
expected.tables.gateway_credential_sets.columns.created_by_org_membership_id = {
  name: "created_by_org_membership_id", type: "varchar(64)", primaryKey: false, notNull: false,
  autoincrement: false,
}
if (!isDeepStrictEqual(expected, snapshot)) {
  throw new Error("Source delta is not exactly gateway_credential_sets.created_by_org_membership_id; resolve unrelated drift separately")
}
const statements = await generateMySQLMigration(previous, snapshot)
if (statements.length !== 1 || statements[0] !== "ALTER TABLE `gateway_credential_sets` ADD `created_by_org_membership_id` varchar(64);" || sql.trim() !== statements[0]) {
  throw new Error(`Unexpected schema/SQL delta: ${JSON.stringify(statements)}`)
}
if (await readFile(journalPath, "utf8") !== journalSource) throw new Error("Journal changed during serialization")
await writeFile(new URL("0097_snapshot.json", meta), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" })
journal.entries.push({ idx: 97, version: snapshot.version, when: Math.max(Date.now(), last.when + 1), tag, breakpoints: true })
await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
console.log(`Registered ${tag}: version=${snapshot.version}; id=${snapshot.id}; prevId=${snapshot.prevId}`)
console.log(`Drizzle schema delta: ${statements[0]}`)
console.log("No SQL executed; historical creators remain unknown. Previous migrations and JSON defaults unchanged.")
