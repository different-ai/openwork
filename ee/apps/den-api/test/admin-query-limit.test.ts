import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { assertReadOnlySql, isDatabaseTimeLimitError, withDatabaseTimeLimit } from "../src/mcp/admin-query-limit.js"

const hint = "/*+ MAX_EXECUTION_TIME(14000) */ /*vt+ QUERY_TIMEOUT_MS=14000 */"

test("a SELECT carries the time limit to the database", () => {
  assert.equal(
    withDatabaseTimeLimit("SELECT org_id, COUNT(*) FROM audit_event GROUP BY org_id LIMIT 200", 14_000),
    `SELECT ${hint} org_id, COUNT(*) FROM audit_event GROUP BY org_id LIMIT 200`,
  )
})

test("a WITH statement gets it on the SELECT after its CTEs, not inside one", () => {
  const sqlText = "WITH recent AS (SELECT org_id FROM audit_event WHERE created_at > NOW() - INTERVAL 1 DAY) SELECT org_id, COUNT(*) FROM recent GROUP BY org_id"
  assert.equal(
    withDatabaseTimeLimit(sqlText, 14_000),
    `WITH recent AS (SELECT org_id FROM audit_event WHERE created_at > NOW() - INTERVAL 1 DAY) SELECT ${hint} org_id, COUNT(*) FROM recent GROUP BY org_id`,
  )
})

test("quoted text, identifiers and comments that say select are left alone", () => {
  const sqlText = "/* select count */ -- select\nSELECT 'select' AS `select`, \"it's select\" FROM t"
  assert.equal(
    withDatabaseTimeLimit(sqlText, 14_000),
    `/* select count */ -- select\nSELECT ${hint} 'select' AS \`select\`, "it's select" FROM t`,
  )
  assert.equal(withDatabaseTimeLimit("SELECT selected, select_count FROM t", 14_000), `SELECT ${hint} selected, select_count FROM t`)
})

test("an existing optimizer hint is joined, since MySQL reads one hint comment per query block", () => {
  assert.equal(
    withDatabaseTimeLimit("SELECT /*+ INDEX(a audit_event_org_id) */ * FROM audit_event a", 14_000),
    "SELECT /*+ MAX_EXECUTION_TIME(14000) INDEX(a audit_event_org_id) */ /*vt+ QUERY_TIMEOUT_MS=14000 */ * FROM audit_event a",
  )
})

test("EXPLAIN limits the statement it runs; SHOW and DESCRIBE are unchanged", () => {
  assert.equal(withDatabaseTimeLimit("EXPLAIN ANALYZE SELECT * FROM audit_event", 14_000), `EXPLAIN ANALYZE SELECT ${hint} * FROM audit_event`)
  assert.equal(withDatabaseTimeLimit("SHOW FULL PROCESSLIST", 14_000), "SHOW FULL PROCESSLIST")
  assert.equal(withDatabaseTimeLimit("DESCRIBE audit_event", 14_000), "DESCRIBE audit_event")
})

test("a database time-limit stop is recognized through the driver's wrapped errors", () => {
  const mysql = Object.assign(new Error("Query execution was interrupted, maximum statement execution time exceeded"), { errno: 3024 })
  assert.equal(isDatabaseTimeLimitError(new Error("Failed query: SELECT 1", { cause: mysql })), true)
  assert.equal(isDatabaseTimeLimitError(new Error("Failed query", { cause: new Error("target: den.-.primary: vttablet: rpc error: code = DeadlineExceeded desc = context deadline exceeded") })), true)
  assert.equal(isDatabaseTimeLimitError(new Error("Failed query", { cause: new Error("Unknown column 'nope' in 'field list'") })), false)
})

test("den_query refuses SELECT token FROM session however the table is written", () => {
  for (const sqlText of [
    "SELECT token FROM session",
    "select * from SESSION where user_id = 'usr_1'",
    "SELECT `token` FROM `session`",
    "SELECT s.token FROM den.session AS s",
    "SELECT s.token FROM `den`.`session` s",
    "SELECT \"token\" FROM \"session\"",
    "SELECT u.email FROM user u JOIN session s ON s.user_id = u.id",
    "SELECT email FROM user WHERE id IN (SELECT user_id FROM session)",
    "WITH t AS (SELECT token FROM session) SELECT * FROM t",
    "SELECT name FROM user UNION ALL SELECT token FROM session",
    "SELECT `a'b`, token FROM session",
  ]) {
    assert.throws(() => assertReadOnlySql(sqlText), /cannot read session: it holds credentials/, sqlText)
  }
})

test("den_query refuses the other credential tables and server internals", () => {
  for (const [sqlText, word] of [
    ["SELECT access_token, refresh_token, id_token, password FROM account", "account"],
    ["SELECT value FROM verification", "verification"],
    ["SELECT `key` FROM apikey", "apikey"],
    ["SELECT private_key FROM jwks", "jwks"],
    ["SELECT token FROM oauthAccessToken", "oauthaccesstoken"],
    ["SELECT token FROM `oauthRefreshToken`", "oauthrefreshtoken"],
    ["SELECT scopes FROM oauthConsent", "oauthconsent"],
    ["SELECT invite_token FROM invitation", "invitation"],
    ["SELECT session_token FROM desktop_handoff_grant", "desktop_handoff_grant"],
    ["SELECT token FROM worker_token", "worker_token"],
    ["SELECT access_token FROM connected_account", "connected_account"],
    ["SELECT secret FROM gateway_provider_credentials", "gateway_provider_credentials"],
    ["SHOW FULL PROCESSLIST", "processlist"],
    ["SELECT info FROM information_schema.PROCESSLIST", "processlist"],
    ["SELECT sql_text FROM performance_schema.events_statements_history", "performance_schema"],
    ["SELECT LOAD_FILE('/etc/hosts')", "load_file"],
  ] as const) {
    assert.throws(() => assertReadOnlySql(sqlText), new RegExp(`cannot read ${word}:`), sqlText)
  }
})

test("den_query refuses syntax the database could read differently from the guard", () => {
  // Each would hide `token FROM session` inside what looks like a string under one reading.
  assert.throws(() => assertReadOnlySql("SELECT '\\', token FROM session -- '"), /Backslashes are not allowed/)
  assert.throws(() => assertReadOnlySql("SELECT 1 --x'\n, token FROM session -- '"), /Write -- only to start a comment/)
  assert.throws(() => assertReadOnlySql("SELECT 1 /* ' */, token FROM session /* ' */"), /Comments cannot contain quotes/)
  assert.throws(() => assertReadOnlySql("SELECT 1 # it's\n, token FROM session WHERE 'x' = 'x'"), /Comments cannot contain quotes/)
  assert.throws(() => assertReadOnlySql("SELECT 1 /*!, token FROM session */"), /Executable comments/)
})

test("den_query still runs ordinary reads, including text and columns that mention sessions", async () => {
  for (const sqlText of [
    "SELECT event_type, COUNT(*) FROM telemetry_event WHERE event_type = 'session.active' GROUP BY event_type",
    "SELECT t.session_id, t.member_id FROM telemetry_event t WHERE t.org_id = 'org_1' LIMIT 10",
    "SELECT /*+ INDEX(a audit_event_org_id) */ * FROM audit_event a -- recent audit\nWHERE a.created_at > NOW() - INTERVAL 1 DAY",
    "SELECT name AS `org name`, 'it''s' AS note FROM organization",
    "SHOW TABLES",
    "DESCRIBE audit_event",
  ]) {
    assert.equal(assertReadOnlySql(sqlText), sqlText)
  }
  const guide = await readFile(new URL("../../../../docs/workbot-adoption.md", import.meta.url), "utf8")
  const documented = /## `den_query` example[\s\S]*?```sql\n([\s\S]*?)```/.exec(guide)?.[1]
  assert.ok(documented)
  assert.equal(assertReadOnlySql(documented), documented.trim())
})

test("den_query still refuses writes", () => {
  assert.throws(() => assertReadOnlySql("UPDATE user SET name = 'x'"), /Only SELECT/)
  assert.throws(() => assertReadOnlySql("SELECT id FROM user FOR UPDATE"), /forbidden keyword/)
  assert.throws(() => assertReadOnlySql("SELECT 1; SELECT 2"), /single SQL statement/)
})
