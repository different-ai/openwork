import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync(new URL("../drizzle/0097_gateway_access_matrix.sql", import.meta.url), "utf8")
const packets = migration.split("--> statement-breakpoint")
const statements = packets.map((packet) => packet.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean)
const metadata = statements.filter((sql) => /information_schema\./i.test(sql))

test("0097 keeps canonical LF bytes for its reviewed migration hash", () => {
  const attributes = readFileSync(new URL("../../../../.gitattributes", import.meta.url), "utf8")
  assert.match(attributes, /^\/ee\/packages\/den-db\/drizzle\/0097_gateway_access_matrix\.sql text eol=lf$/m)
  assert.equal(migration.includes("\r"), false)
})
const sourceTables = [
  "inference_providers", "inference_provider_models", "inference_provider_credentials",
  "inference_provider_access", "inference_provider_oauth_states",
  "inference_request_logs", "inference_usage_rollups", "inference_rollup_lock",
]
const observationColumns = [
  "input_tokens_count", "output_tokens_count", "total_tokens_count", "cache_read_tokens_count",
  "cache_write_tokens_count", "reasoning_tokens_count", "cost_count", "latency_count",
  "ttfb_count", "request_bytes_count", "response_bytes_count",
]
const destinationTables = [
  "gateway_providers", "gateway_provider_models", "gateway_provider_credentials",
  "gateway_provider_access", "gateway_provider_oauth_states", "gateway_request_logs",
  "gateway_usage_rollups", "gateway_rollup_lock", "gateway_keys", "gateway_model_groups",
  "gateway_model_group_models", "gateway_credential_sets",
]
const requiredIndexes = [
  ["inference_providers", "inference_providers_organization_id"],
  ["inference_providers", "inference_providers_org_provider_id"],
  ["inference_provider_models", "inference_provider_models_model_id"],
  ["inference_provider_models", "inference_provider_models_provider_model"],
  ["inference_provider_credentials", "inference_provider_credentials_org_membership_id"],
  ["inference_provider_credentials", "inference_provider_credentials_organization_id"],
  ["inference_provider_credentials", "inference_provider_credentials_provider_subject"],
  ["inference_provider_access", "inference_provider_access_org_membership_id"],
  ["inference_provider_access", "inference_provider_access_team_id"],
  ["inference_provider_access", "inference_provider_access_provider_org_membership"],
  ["inference_provider_access", "inference_provider_access_provider_team"],
  ["inference_provider_oauth_states", "inference_provider_oauth_states_state"],
  ["inference_provider_oauth_states", "inference_provider_oauth_states_expires_at"],
  ["inference_request_logs", "inference_request_logs_openwork_request_id"],
  ["inference_request_logs", "inference_request_logs_org_started"],
  ["inference_request_logs", "inference_request_logs_member_started"],
  ["inference_request_logs", "inference_request_logs_provider_started"],
  ["inference_request_logs", "inference_request_logs_started_at"],
  ["inference_usage_rollups", "inference_usage_rollups_bucket_dimension"],
  ["inference_usage_rollups", "inference_usage_rollups_org_granularity_bucket"],
]

test("0097 metadata guards preserve the exact source predicates and fail-closed counts", () => {
  const quoted = (names: string[]) => names.map((name) => `'${name}'`).join(", ")
  const expected = [
    { count: "COUNT(*) = 8", reason: "0097_requires_complete_0096_schema", table: "TABLES",
      predicate: `TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME IN (${quoted(sourceTables)})` },
    { count: "COUNT(*) = 11", reason: "0097_requires_complete_0096_schema", table: "COLUMNS",
      predicate: `TABLE_NAME = 'inference_usage_rollups' AND COLUMN_NAME IN (${quoted(observationColumns)})` },
    { count: "COUNT(*) = 1", reason: "0097_requires_complete_0096_schema", table: "COLUMNS",
      predicate: "TABLE_NAME = 'inference_keys' AND COLUMN_NAME = 'encrypted_key'" },
    { count: "COUNT(*) = 0", reason: "0097_gateway_tables_already_exist", table: "TABLES",
      predicate: `TABLE_NAME IN (${quoted(destinationTables)})` },
    { count: "COUNT(DISTINCT TABLE_NAME, INDEX_NAME) = 20", reason: "0097_missing_legacy_indexes", table: "STATISTICS",
      predicate: `(${requiredIndexes.map(([table, index]) => `(TABLE_NAME = '${table}' AND INDEX_NAME = '${index}')`).join(" OR ")})` },
  ]
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim()
  assert.equal(metadata.length, 5)
  assert.deepEqual(metadata.map(normalize), expected.map(({ count, reason, table, predicate }) => normalize(
    `SELECT JSON_EXTRACT(IF(${count}, '{}', '${reason}'), '$') AS preflight
     FROM information_schema.${table} WHERE TABLE_SCHEMA = DATABASE() AND ${predicate};`,
  )))
  for (const sql of metadata) {
    assert.equal(sql.match(/\bSELECT\b/gi)?.length, 1)
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|JOIN|UNION|EXISTS|HAVING)\b/i)
  }
  const rename = statements.findIndex((sql) => sql.startsWith("RENAME TABLE"))
  assert.ok(rename > 0)
  assert.ok(metadata.every((sql) => statements.indexOf(sql) < rename))
})

test("0097 keeps every non-metadata SQL packet unchanged from the recovery base", () => {
  // Fingerprint of comment-stripped non-metadata packets at 667b450fd; original
  // full SQL SHA-256: dec021c8b3bb9fb139b3e0737ac5618ab1ed74d64d82fe36e1fcfe71306f378d.
  // Includes temporary guard creation/seeds/drop, version/mode/data guards,
  // and every persistent DDL, backfill and index change, in their original order.
  const unchanged = statements.filter((sql) => !/information_schema\./i.test(sql))
  assert.equal(statements.length, 40)
  assert.equal(unchanged.length, 35)
  assert.equal(createHash("sha256").update(unchanged.join("\n--> statement-breakpoint\n")).digest("hex"),
    "6dd874e369061b0b85623ecbec6073c52cb61bdabc718efbfd7373694e9300dd")
})

test("0097-0099 breakpoint packets end in SQL, not trailing comments", () => {
  for (const file of ["0097_gateway_access_matrix.sql", "0098_gateway_provider_model_universe.sql", "0099_gateway_credential_set_creator.sql"]) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8")
    for (const [index, packet] of sql.split("--> statement-breakpoint").entries()) {
      assert.ok(packet.trim().endsWith(";"), `${file} packet ${index + 1} must end with its SQL semicolon`)
      const executable = packet.replace(/^\s*--[^\n]*$/gm, "").trim()
      assert.equal(executable.match(/;/g)?.length, 1, `${file} packet ${index + 1} must contain one statement`)
    }
  }
})
