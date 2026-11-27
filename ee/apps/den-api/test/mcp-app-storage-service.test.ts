import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { McpAppStorage } from "@openwork/types/mcp-app"
import { MCP_APP_STORAGE_SCHEMA, McpAppStorageBackendError, type McpAppStorageBackend } from "../src/mcp-app-storage/backend.js"
import { createLocalStorageBackend } from "../src/mcp-app-storage/local-backend.js"
import { McpAppStorageError, readMcpAppStorage, writeMcpAppStorage, type McpAppStorageAccess, type McpAppStorageRegistry } from "../src/mcp-app-storage/service.js"

const directory = mkdtempSync(path.join(tmpdir(), "artifact-storage-service-"))
after(() => rmSync(directory, { recursive: true, force: true }))

const ORGANIZATION = "org_01kq0000000000000000000001"
const ANA = { memberId: "om_01kq0000000000000000000001", name: "Ana" }
const BEN = { memberId: "om_01kq0000000000000000000002", name: "Ben" }

const storage: McpAppStorage = {
  collections: [
    {
      name: "requests",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "status", type: "text", options: ["new", "approved", "rejected"] },
        { name: "amount", type: "number" },
        { name: "urgent", type: "boolean" },
        { name: "due", type: "date" },
      ],
    },
    { name: "notes", scope: "personal", fields: [{ name: "body", type: "text", required: true }] },
    { name: "claims", edit: "creator", fields: [{ name: "item", type: "text", required: true }] },
  ],
}

let nextApp = 0
function world(overrides: Partial<Pick<McpAppStorageAccess, "limits" | "backend" | "storage">> = {}) {
  nextApp += 1
  const ref = { organizationId: ORGANIZATION, appId: `cob_01kq${String(nextApp).padStart(22, "0")}` }
  const records = new Map<string, { sizeBytes: number; rowCount: number }>()
  const registry: McpAppStorageRegistry = {
    read: async (target) => records.get(target.appId) ?? null,
    record: async (target, usage) => { records.set(target.appId, { sizeBytes: usage.sizeBytes, rowCount: usage.rowCount }) },
  }
  const backend = overrides.backend ?? createLocalStorageBackend({ directory, schema: MCP_APP_STORAGE_SCHEMA })
  const as = (actor: typeof ANA): McpAppStorageAccess => ({
    ref,
    storage: overrides.storage ?? storage,
    actor,
    backend,
    limits: overrides.limits ?? { maxRows: 100, maxBytes: 1024 * 1024 },
    registry,
  })
  return { ref, records, backend, as }
}

async function refusal(work: Promise<unknown>): Promise<McpAppStorageError> {
  try {
    await work
  } catch (error) {
    if (error instanceof McpAppStorageError) return error
    throw error
  }
  throw new Error("expected a refusal")
}

test("a row one member adds is read back by another member, with who added it", async () => {
  const { as, records, ref } = world()
  const added = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "  New laptop ", status: "new", amount: 1200.5, urgent: true, due: "2026-12-01" } })
  assert.equal(added.row?.values.title, "New laptop")
  assert.equal(added.row?.mine, true)
  const seen = await readMcpAppStorage(as(BEN), { collection: "requests" })
  assert.equal(seen.total, 1)
  assert.deepEqual(seen.rows[0]?.values, { title: "New laptop", status: "new", amount: 1200.5, urgent: true, due: "2026-12-01" })
  assert.equal(seen.rows[0]?.createdBy, "Ana")
  assert.equal(seen.rows[0]?.mine, false)
  assert.equal(records.get(ref.appId)?.rowCount, 1)
  assert.ok((records.get(ref.appId)?.sizeBytes ?? 0) > 0)
})

test("another member changes a shared row and both see the change", async () => {
  const { as } = world()
  const added = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "Monitor", status: "new" } })
  const changed = await writeMcpAppStorage(as(BEN), { collection: "requests", action: "update", id: added.id, values: { status: "approved" } })
  assert.equal(changed.row?.values.status, "approved")
  assert.equal(changed.row?.values.title, "Monitor")
  assert.equal(changed.row?.updatedBy, "Ben")
  assert.equal(changed.row?.createdBy, "Ana")
  const seen = await readMcpAppStorage(as(ANA), { collection: "requests", where: { status: "approved" } })
  assert.equal(seen.rows.length, 1)
})

test("values are checked against the artifact's fields before anything is saved", async () => {
  const { as } = world()
  const cases: Array<[Record<string, string | number | boolean | null>, string]> = [
    [{ status: "new" }, "missing_value"],
    [{ title: "" }, "missing_value"],
    [{ title: "A", status: "maybe" }, "invalid_value"],
    [{ title: "A", amount: "12" }, "invalid_value"],
    [{ title: "A", urgent: "yes" }, "invalid_value"],
    [{ title: "A", due: "tomorrow" }, "invalid_value"],
    [{ title: "A", owner: "someone" }, "unknown_field"],
    [{ title: "x".repeat(4001) }, "invalid_value"],
  ]
  for (const [values, code] of cases) {
    assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values }))).code, code, JSON.stringify(values).slice(0, 60))
  }
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "payroll", action: "insert", values: { title: "A" } }))).code, "unknown_collection")
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", id: "mine", values: { title: "A" } }))).code, "invalid_input")
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "drop" }))).code, "invalid_input")
  assert.equal((await readMcpAppStorage(as(ANA), { collection: "requests" })).total, 0)
})

test("a required value cannot be cleared by an update, and an optional one can", async () => {
  const { as } = world()
  const added = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "Desk", amount: 300 } })
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "update", id: added.id, values: { title: null } }))).code, "missing_value")
  const cleared = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "update", id: added.id, values: { amount: null } })
  assert.equal(cleared.row?.values.amount, null)
  assert.equal(cleared.row?.values.title, "Desk")
})

test("a personal row is invisible to everyone but the person who added it", async () => {
  const { as } = world()
  const note = await writeMcpAppStorage(as(ANA), { collection: "notes", action: "insert", values: { body: "Ask about budget" } })
  assert.equal((await readMcpAppStorage(as(ANA), { collection: "notes" })).total, 1)
  assert.equal((await readMcpAppStorage(as(BEN), { collection: "notes" })).total, 0)
  assert.equal((await refusal(writeMcpAppStorage(as(BEN), { collection: "notes", action: "update", id: note.id, values: { body: "Changed" } }))).code, "row_not_found")
  assert.equal((await refusal(writeMcpAppStorage(as(BEN), { collection: "notes", action: "delete", id: note.id }))).code, "row_not_found")
  assert.equal((await readMcpAppStorage(as(ANA), { collection: "notes" })).rows[0]?.values.body, "Ask about budget")
})

test("with edit set to creator, only the person who added a shared row changes or removes it", async () => {
  const { as } = world()
  const claim = await writeMcpAppStorage(as(ANA), { collection: "claims", action: "insert", values: { item: "Taxi" } })
  assert.equal((await readMcpAppStorage(as(BEN), { collection: "claims" })).total, 1)
  assert.equal((await refusal(writeMcpAppStorage(as(BEN), { collection: "claims", action: "update", id: claim.id, values: { item: "Limo" } }))).code, "not_allowed")
  assert.equal((await refusal(writeMcpAppStorage(as(BEN), { collection: "claims", action: "delete", id: claim.id }))).code, "not_allowed")
  await writeMcpAppStorage(as(ANA), { collection: "claims", action: "delete", id: claim.id })
  assert.equal((await readMcpAppStorage(as(BEN), { collection: "claims" })).total, 0)
})

test("a row id from one collection does not reach a row in another", async () => {
  const { as } = world()
  const request = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "Chair" } })
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "claims", action: "delete", id: request.id }))).code, "row_not_found")
  assert.equal((await readMcpAppStorage(as(ANA), { collection: "requests" })).total, 1)
})

test("an artifact stops accepting rows at its row cap, and accepts again after one is removed", async () => {
  const { as } = world({ limits: { maxRows: 2, maxBytes: 1024 * 1024 } })
  const first = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "One" } })
  await writeMcpAppStorage(as(BEN), { collection: "notes", action: "insert", values: { body: "Two" } })
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "Three" } }))).code, "storage_full")
  await writeMcpAppStorage(as(ANA), { collection: "requests", action: "delete", id: first.id })
  await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "Three" } })
  assert.equal((await readMcpAppStorage(as(ANA), { collection: "requests" })).total, 1)
})

test("an artifact stops accepting rows and changes at its size cap, and removing still works", async () => {
  const { as } = world({ limits: { maxRows: 100, maxBytes: 1 } })
  const first = await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "One" } })
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "Two" } }))).code, "storage_full")
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "update", id: first.id, values: { title: "Uno" } }))).code, "storage_full")
  await writeMcpAppStorage(as(ANA), { collection: "requests", action: "delete", id: first.id })
})

test("one entry larger than the row limit is refused", async () => {
  const many = { collections: [{ name: "big", fields: Array.from({ length: 6 }, (_, index) => ({ name: `f${index}`, type: "text" as const })) }] }
  const { as } = world({ storage: many })
  const values = Object.fromEntries(many.collections[0].fields.map((field) => [field.name, "y".repeat(3500)]))
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "big", action: "insert", values }))).code, "row_too_large")
})

test("rows stay when the artifact's fields change: a new field reads empty, a removed one is hidden but kept", async () => {
  const before = { collections: [{ name: "tasks", fields: [{ name: "title", type: "text" as const, required: true }, { name: "old_note", type: "text" as const }] }] }
  const first = world({ storage: before })
  const added = await writeMcpAppStorage(first.as(ANA), { collection: "tasks", action: "insert", values: { title: "Ship", old_note: "keep me" } })
  const after = { collections: [{ name: "tasks", fields: [{ name: "title", type: "text" as const, required: true }, { name: "points", type: "number" as const }] }] }
  const later = { ...first.as(BEN), storage: after }
  const seen = await readMcpAppStorage(later, { collection: "tasks" })
  assert.deepEqual(seen.rows[0]?.values, { title: "Ship", points: null })
  await writeMcpAppStorage(later, { collection: "tasks", action: "update", id: added.id, values: { points: 3 } })
  const restored = await readMcpAppStorage(first.as(ANA), { collection: "tasks" })
  assert.equal(restored.rows[0]?.values.old_note, "keep me")
})

test("reads filter, order and page, and refuse a field the artifact does not declare", async () => {
  const { as } = world()
  for (const [title, amount] of [["B", 2], ["A", 3], ["C", 1]] as const) {
    await writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title, amount, urgent: amount > 1 } })
  }
  const byAmount = await readMcpAppStorage(as(ANA), { collection: "requests", orderBy: "amount", order: "asc" })
  assert.deepEqual(byAmount.rows.map((row) => row.values.title), ["C", "B", "A"])
  const urgent = await readMcpAppStorage(as(ANA), { collection: "requests", where: { urgent: true }, orderBy: "title", order: "asc", limit: 1, offset: 1 })
  assert.equal(urgent.total, 2)
  assert.deepEqual(urgent.rows.map((row) => row.values.title), ["B"])
  assert.equal((await refusal(readMcpAppStorage(as(ANA), { collection: "requests", where: { "x') OR 1=1 --": "1" } }))).code, "unknown_field")
  assert.equal((await refusal(readMcpAppStorage(as(ANA), { collection: "requests", orderBy: "data; DROP TABLE artifact_rows" }))).code, "unknown_field")
  assert.equal((await refusal(readMcpAppStorage(as(ANA), { collection: "requests", limit: 500 }))).code, "invalid_input")
})

test("a failing backend reads as unavailable and never as an empty list", async () => {
  const broken: McpAppStorageBackend = {
    kind: "celld",
    query: async () => { throw new McpAppStorageBackendError("down") },
    write: async () => { throw new McpAppStorageBackendError("down") },
    export: async () => null,
    delete: async () => undefined,
  }
  const { as } = world({ backend: broken })
  assert.equal((await refusal(readMcpAppStorage(as(ANA), { collection: "requests" }))).code, "storage_unavailable")
  assert.equal((await refusal(writeMcpAppStorage(as(ANA), { collection: "requests", action: "insert", values: { title: "A" } }))).code, "storage_unavailable")
})
