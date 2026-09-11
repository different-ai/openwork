import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync(new URL("../drizzle/0097_gateway_access_matrix.sql", import.meta.url), "utf8")
const statements = migration.split("--> statement-breakpoint").map((packet) => packet.trim())
const sourceTables = [
  "inference_request_logs", "inference_rollup_lock", "inference_usage_rollups",
  "inference_provider_access", "inference_provider_credentials", "inference_provider_models",
  "inference_provider_oauth_states", "inference_providers",
]

test("0097 preserves the raw generated SQL bytes and one statement per packet", () => {
  const attributes = readFileSync(new URL("../../../../.gitattributes", import.meta.url), "utf8")
  assert.match(attributes, /^\/ee\/packages\/den-db\/drizzle\/0097_gateway_access_matrix\.sql text eol=lf$/m)
  assert.equal(migration.includes("\r"), false)
  assert.equal(createHash("sha256").update(migration).digest("hex"),
    "96e872e1fdf004ff4cdf66715a589a442dff80170f2b47e70204b38a2fd09470")
  assert.equal(statements.length, 98)
  for (const sql of statements) {
    assert.ok(sql.endsWith(";"))
    assert.equal(sql.match(/;/g)?.length, 1)
    assert.match(sql, /^(CREATE|ALTER|RENAME|DROP INDEX)\b/)
    assert.doesNotMatch(sql, /^(INSERT|UPDATE|DELETE|SELECT|DROP TABLE|TRUNCATE)\b|DROP COLUMN|information_schema|__gateway_0097_preflight/i)
  }
})

test("0097 creates four final tables and renames all eight intermediate tables", () => {
  assert.deepEqual(statements.filter((sql) => sql.startsWith("CREATE TABLE")).map((sql) => /^CREATE TABLE `([^`]+)`/.exec(sql)?.[1]), [
    "gateway_credential_sets", "gateway_keys", "gateway_model_group_models", "gateway_model_groups",
  ])
  assert.deepEqual(statements.filter((sql) => sql.startsWith("RENAME TABLE")), sourceTables.map((table) =>
    `RENAME TABLE \`${table}\` TO \`${table.replace("inference_", "gateway_")}\`;`))
  assert.equal(statements.filter((sql) => sql.includes("RENAME COLUMN")).length, 7)
  assert.match(statements[0], /`created_by_org_membership_id` varchar\(64\),/)
  assert.ok(statements.includes("ALTER TABLE `gateway_providers` ADD `model_ids` json DEFAULT (JSON_ARRAY()) NOT NULL;"))
  assert.match(migration, /ADD CONSTRAINT `gateway_provider_access_audience` CHECK/)
  // Generated table-derived PK renames cause separate drops/adds. Preserve
  // them here, but this shape assertion is not target-engine replay evidence.
  for (const source of sourceTables) {
    const table = source.replace("inference_", "gateway_")
    assert.ok(statements.includes(`ALTER TABLE \`${table}\` DROP PRIMARY KEY;`))
    assert.ok(statements.includes(`ALTER TABLE \`${table}\` ADD PRIMARY KEY(\`id\`);`))
  }
})

test("pre-consolidation 0095/0096 SQL and snapshots retain base f128bff74 bytes", () => {
  const hashes = {
    "0095_inference_gateway_providers.sql": "3d030e1cc022d40ac5c0627920e035d6f9639bf265f022b39321d53004f6a6f9",
    "0096_inference_accounting_observations.sql": "19e12d4f2f8247febe5a6882969f9408bfc0eb3fb2acc3d999847bc49027cd3a",
    "meta/0095_snapshot.json": "84cac88328f1b3cc09f52644b82345b63cc4834340b25594af9aa24961b39b6c",
    "meta/0096_snapshot.json": "62c1d2787cd6064a258238dfc1c066bfa3bde1dbf4a33b4ebc8f1af906a74282",
  }
  for (const [file, hash] of Object.entries(hashes)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../drizzle/${file}`, import.meta.url))).digest("hex"), hash, file)
  }
})

test("all 186 historical artifacts and journal entries through 0096 retain base f128bff74 bytes", () => {
  const files = [
    ...readdirSync(new URL("../drizzle/", import.meta.url)),
    ...readdirSync(new URL("../drizzle/meta/", import.meta.url)).map((file) => `meta/${file}`),
  ].filter((file) => {
    const match = /^(?:meta\/)?(\d{4})(?:_|\.)/.exec(file)
    return match && Number(match[1]) <= 96
  }).sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(`${file}\0`)
    hash.update(readFileSync(new URL(`../drizzle/${file}`, import.meta.url)))
    hash.update("\0")
  }
  assert.equal(files.length, 186)
  assert.equal(hash.digest("hex"), "30f23bddc8c4457ee2fb379a2640c806fdc110bf01bbfc7252f09c3516027763")
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"))
  assert.equal(createHash("sha256").update(JSON.stringify(journal.entries.slice(0, 96))).digest("hex"),
    "c4e85b6219cefe3d0fb3630e69804bb09be6932e8101c9983a0a30ed94389985")
})

test("the journal ends at consolidated 0097 with no obsolete 0098/0099 artifacts", () => {
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"))
  assert.equal(journal.entries.length, 97)
  assert.deepEqual(journal.entries.at(-1), {
    idx: 97, version: "5", when: 1788895934602, tag: "0097_gateway_access_matrix", breakpoints: true,
  })
  for (const file of [
    "0098_gateway_provider_model_universe.sql", "0099_gateway_credential_set_creator.sql",
    "meta/0098_snapshot.json", "meta/0099_snapshot.json",
  ]) assert.equal(existsSync(new URL(`../drizzle/${file}`, import.meta.url)), false)
})
