import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, it, type TestContext } from "node:test"
import { McpAppStorageBackendError, type McpAppStorageBackend, type StorageDatabaseRef } from "../src/mcp-app-storage/backend.js"
import { createCelldStorageBackend } from "../src/mcp-app-storage/celld-backend.js"
import { createLocalStorageBackend } from "../src/mcp-app-storage/local-backend.js"

const schema = {
  version: 1,
  statements: [
    "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL, quantity REAL, note TEXT)",
    "CREATE INDEX IF NOT EXISTS entries_label ON entries (label)",
    'CREATE TABLE IF NOT EXISTS "keyed table" ("quoted""key" TEXT PRIMARY KEY) WITHOUT ROWID',
  ],
}
const select = { sql: "SELECT * FROM entries ORDER BY id" }
const insert = { sql: "INSERT INTO entries (id, label, quantity, note) VALUES (?, ?, ?, ?)", params: [1, "雪 🫖 'quoted'", 1.25, null] }
const first = { id: 1, label: "雪 🫖 'quoted'", quantity: 1.25, note: null }
const id = (prefix: string) => `${prefix}_${randomBytes(13).toString("hex")}`

function contract(name: string, factory: (t: TestContext) => McpAppStorageBackend, skip?: string) {
  function fixture(t: TestContext) {
    const backend = factory(t)
    const refs: StorageDatabaseRef[] = []
    t.after(async () => {
      for (const ref of refs) await backend.delete(ref)
    })
    function newRef(overrides?: Partial<StorageDatabaseRef>) {
      const ref = { organizationId: id("org"), appId: id("cob"), ...overrides }
      refs.push(ref)
      return ref
    }
    return { backend, newRef }
  }

  describe(`${name} artifact storage contract`, { skip }, () => {
    it("reads empty and exports null before a write", async (t) => {
      const { backend, newRef } = fixture(t)
      const ref = newRef()
      assert.deepEqual(await backend.query(ref, select), { rows: [] })
      assert.equal(await backend.export(ref), null)
    })

    it("applies schema, preserves values, and reports each statement's changes and database growth", async (t) => {
      const { backend, newRef } = fixture(t)
      const ref = newRef()
      const small = await backend.write(ref, [insert, { sql: "UPDATE entries SET label = label WHERE id = -1" }, { sql: "UPDATE entries SET note = ? WHERE id = 1", params: [null] }])
      assert.deepEqual(small.changes, [1, 0, 1])
      assert.ok(small.sizeBytes > 0)
      assert.deepEqual((await backend.query(ref, select)).rows, [first])
      const large = await backend.write(ref, [{ sql: "INSERT INTO entries (label) VALUES (?)", params: ["x".repeat(120_000)] }])
      assert.ok(large.sizeBytes > small.sizeBytes)
    })

    it("rolls back a whole failed batch", async (t) => {
      const { backend, newRef } = fixture(t)
      const ref = newRef()
      await backend.write(ref, [insert])
      await assert.rejects(backend.write(ref, [
        { sql: "UPDATE entries SET label = 'changed' WHERE id = 1" },
        insert,
      ]), McpAppStorageBackendError)
      assert.deepEqual((await backend.query(ref, select)).rows, [first])
    })

    it("isolates refs in both the organization and app dimensions", async (t) => {
      const { backend, newRef } = fixture(t)
      const a = newRef()
      const b = newRef({ organizationId: a.organizationId })
      const c = newRef({ appId: a.appId })
      await backend.write(a, [insert])
      for (const [ref, label] of [[b, "other app"], [c, "other org"]] as const) {
        assert.deepEqual((await backend.query(ref, select)).rows, [])
        await backend.write(ref, [{ ...insert, params: [1, label, null, null] }])
        assert.deepEqual((await backend.query(ref, select)).rows, [{ id: 1, label, quantity: null, note: null }])
      }
      assert.deepEqual((await backend.query(a, select)).rows, [first])
    })

    it("exports an openable SQLite file with every page of rows and no backend tables", async (t) => {
      const { backend, newRef } = fixture(t)
      const ref = newRef()
      await backend.write(ref, [insert, {
        sql: "WITH RECURSIVE ids(i) AS (VALUES(2) UNION ALL SELECT i + 1 FROM ids WHERE i < 260) INSERT INTO entries (id, label) SELECT i, 'row' FROM ids",
      }, { sql: 'INSERT INTO "keyed table" VALUES (?)', params: ["☀"] }])
      const bytes = await backend.export(ref)
      assert.ok(bytes)
      const directory = mkdtempSync(path.join(os.tmpdir(), "openwork-test-artifact-export-"))
      t.after(() => rmSync(directory, { recursive: true, force: true }))
      const file = path.join(directory, "export.sqlite")
      writeFileSync(file, bytes)
      const database = new DatabaseSync(file, { readOnly: true })
      try {
        assert.deepEqual(database.prepare(select.sql).all().map((row) => ({ ...row })), (await backend.query(ref, select)).rows)
        assert.equal(database.prepare('SELECT "quoted""key" AS value FROM "keyed table"').get()?.value, "☀")
        assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all().map((row) => row.name), ["entries", "entries_label", "keyed table"])
      } finally {
        database.close()
      }
    })

    it("deletes idempotently and reapplies schema on rewrite", async (t) => {
      const { backend, newRef } = fixture(t)
      const ref = newRef()
      await backend.write(ref, [insert])
      await backend.delete(ref)
      await backend.delete(ref)
      assert.deepEqual(await backend.query(ref, select), { rows: [] })
      assert.equal(await backend.export(ref), null)
      assert.deepEqual((await backend.write(ref, [insert])).changes, [1])
    })

    it("rejects malformed ids for all operations", async (t) => {
      const { backend, newRef } = fixture(t)
      const ref = newRef()
      for (const bad of [{ ...ref, organizationId: "../escape" }, { ...ref, appId: "invalid" }]) {
        await assert.rejects(backend.query(bad, select), McpAppStorageBackendError)
        await assert.rejects(backend.write(bad, [insert]), McpAppStorageBackendError)
        await assert.rejects(backend.export(bad), McpAppStorageBackendError)
        await assert.rejects(backend.delete(bad), McpAppStorageBackendError)
      }
    })
  })
}

contract("local", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openwork-test-artifact-local-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return createLocalStorageBackend({ directory, schema })
})

const url = process.env.OPENWORK_ARTIFACT_STORAGE_CELLD_URL
const token = process.env.OPENWORK_ARTIFACT_STORAGE_CELLD_TOKEN
contract("celld", () => {
  assert.ok(url && token)
  return createCelldStorageBackend({ url, token, schema })
}, url && token ? undefined : "Set OPENWORK_ARTIFACT_STORAGE_CELLD_URL and OPENWORK_ARTIFACT_STORAGE_CELLD_TOKEN to test real celld.")
