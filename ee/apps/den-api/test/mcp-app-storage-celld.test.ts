import assert from "node:assert/strict"
import { test } from "node:test"
import { MCP_APP_STORAGE_SCHEMA, McpAppStorageBackendError } from "../src/mcp-app-storage/backend.js"
import { createCelldStorageBackend } from "../src/mcp-app-storage/celld-backend.js"

const token = "dummy-artifact-storage-token"
const url = "https://storage.example.test"
const ref = { organizationId: `org_${"a".repeat(26)}`, appId: `cob_${"b".repeat(26)}` }
const statement = { sql: "SELECT 1" }
const createBackend = (fetch: typeof globalThis.fetch) => createCelldStorageBackend({ url, token, schema: MCP_APP_STORAGE_SCHEMA, fetch })

function noSecrets(error: unknown): boolean {
  assert.ok(error instanceof McpAppStorageBackendError)
  assert.ok(!error.message.includes(token))
  assert.ok(!error.message.includes(url))
  assert.equal(error.cause, undefined)
  return true
}

test("celld adapter converts a timeout into a sanitized backend error", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new DOMException(`${url} ${token}`, "TimeoutError")))
  const backend = createBackend(async (_resource, options) => {
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`)
    assert.ok(options?.signal)
    options.signal.throwIfAborted()
    throw new Error("Expected the request to be cancelled")
  })
  await assert.rejects(backend.query(ref, statement), noSecrets)
  assert.deepEqual(timeout.mock.calls.map((call) => call.arguments), [[15_000]])
})

test("celld adapter sanitizes transport errors, upstream 5xx and malformed responses", async () => {
  const transport = createBackend(async () => { throw new Error(`${url} ${token}`) })
  const unavailable = createBackend(async () => Response.json({ error: "sql_error", message: `${url} ${token}` }, { status: 502 }))
  const invalidJson = createBackend(async () => new Response(`${url} ${token}`))
  const invalidRows = createBackend(async () => Response.json({ rows: [{ data: { url, token } }] }))
  const invalidChanges = createBackend(async () => Response.json({ changes: [1, 2], sizeBytes: 123 }))
  for (const backend of [transport, unavailable, invalidJson, invalidRows]) {
    await assert.rejects(backend.query(ref, statement), noSecrets)
  }
  await assert.rejects(invalidChanges.write(ref, [statement]), noSecrets)
  await assert.rejects(unavailable.delete(ref), noSecrets)
  await assert.rejects(unavailable.export(ref), noSecrets)
})

test("celld adapter accepts delete 404 as idempotent success", async () => {
  await createBackend(async () => new Response(null, { status: 404 })).delete(ref)
})
