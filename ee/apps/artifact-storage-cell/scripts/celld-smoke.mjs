#!/usr/bin/env node
// Checks a running artifact-storage Worker over HTTP, the way Den calls it (README, "HTTP contract"):
//
//   ARTIFACT_STORAGE_URL=http://127.0.0.1:18080 ARTIFACT_STORAGE_TOKEN=<token> node scripts/celld-smoke.mjs write
//   ARTIFACT_STORAGE_URL=http://127.0.0.1:18080 ARTIFACT_STORAGE_TOKEN=<token> node scripts/celld-smoke.mjs read
//
// `write` checks that the token is required, writes two rows and reads them back. `read` is for after the node has
// restarted: it finds the same rows, then deletes the database. Both use one database of their own, which no
// organization can have, and need nothing installed.
import assert from "node:assert/strict"

const base = process.env.ARTIFACT_STORAGE_URL?.replace(/\/+$/u, "")
const token = process.env.ARTIFACT_STORAGE_TOKEN
const phase = process.argv[2]
if (!base || !token || (phase !== "write" && phase !== "read")) {
  console.error("Set ARTIFACT_STORAGE_URL and ARTIFACT_STORAGE_TOKEN, and pass write or read.")
  process.exit(2)
}

const database = `/v1/databases/org_${"preflight".padEnd(26, "0")}/cob_${"preflight".padEnd(26, "0")}`
const schema = { version: 1, statements: ["CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, message TEXT NOT NULL)"] }
const rows = [{ id: 1, message: "first" }, { id: 2, message: "second" }]
const select = { schema, statement: { sql: "SELECT id, message FROM smoke ORDER BY id" } }

async function call(method, path, body, authorization = `Bearer ${token}`) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON: the status decides */ }
  return { status: response.status, json }
}

async function expect(label, pending, status, check) {
  const result = await pending
  assert.equal(result.status, status, `${label}: expected ${status}, got ${result.status} ${JSON.stringify(result.json)?.slice(0, 200)}`)
  if (check) check(result.json)
  console.log(`ok: ${label}`)
}

if (phase === "write") {
  await expect("the node is healthy", call("GET", "/health", undefined, ""), 200, (body) => assert.deepEqual(body, { ok: true }))
  await expect("a request without a token is refused", call("POST", `${database}/query`, select, ""), 401)
  await expect("a request with a wrong token is refused", call("POST", `${database}/query`, select, `Bearer ${"x".repeat(token.length)}`), 401)
  await expect("an id that is not a Den id is refused", call("POST", "/v1/databases/nope/nope/query", select), 400, (body) => assert.equal(body.error, "invalid_id"))
  await expect("the database starts absent", call("DELETE", database), 204)
  await expect("a database nothing was written to reads as empty", call("POST", `${database}/query`, select), 200, (body) => assert.deepEqual(body, { rows: [] }))
  await expect("two rows are written in one batch", call("POST", `${database}/write`, {
    schema, statements: rows.map((row) => ({ sql: "INSERT INTO smoke (id, message) VALUES (?, ?)", params: [row.id, row.message] })),
  }), 200, (body) => {
    assert.deepEqual(body.changes, [1, 1])
    assert.ok(body.sizeBytes > 0, "the write reports the database size")
  })
  await expect("a batch with a failing statement is refused", call("POST", `${database}/write`, {
    schema, statements: [{ sql: "INSERT INTO smoke (id, message) VALUES (?, ?)", params: [3, "third"] }, { sql: "INSERT INTO missing VALUES (1)" }],
  }), 400, (body) => assert.equal(body.error, "sql_error"))
  await expect("the rows read back, without the refused batch", call("POST", `${database}/query`, select), 200, (body) => assert.deepEqual(body, { rows }))
} else {
  await expect("the rows are still there after the restart", call("POST", `${database}/query`, select), 200, (body) => assert.deepEqual(body, { rows }))
  await expect("the database is deleted", call("DELETE", database), 204)
  await expect("a deleted database reads as empty", call("POST", `${database}/query`, select), 200, (body) => assert.deepEqual(body, { rows: [] }))
  await expect("deleting it again succeeds", call("DELETE", database), 204)
}
