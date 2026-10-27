/** Numbered migrations (src/storage/migrations.ts): from any database to the latest, and the previous runner still opens it. */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { nodeSqlite } from "../src/node-sqlite.js"
import { SessionStorage, schemaVersion } from "../src/storage/index.js"
import { Store } from "../src/store.js"
import { memoryBlobs, seedConversation, withBaseRunner } from "./storage-fixture.js"

const project = join(import.meta.dirname, "..")
const LATEST = 4
const BASE = process.env.STORAGE_TEST_BASE ?? "origin/dev"

function tempDb() {
  const directory = mkdtempSync(join(tmpdir(), "headless-migrations-"))
  return { path: join(directory, "runner.sqlite"), [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}
const tables = (store: Store) =>
  store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => z.object({ name: z.string() }).parse(row).name)

test("an empty database reaches the latest version, and migrating again changes nothing", () => {
  using db = tempDb()
  const store = new Store(nodeSqlite(db.path))
  try {
    assert.equal(store.migrationError, null)
    assert.equal(schemaVersion(store.db), LATEST)
    const before = tables(store)
    for (const table of ["meta", "segments", "large_bodies", "index_outbox", "seal_state", "storage_deletions"]) assert.ok(before.includes(table), table)
    for (const column of ["hot_bytes", "index_capability", "index_version"]) assert.ok(store.columns("sessions").has(column), column)
    store.migrate()
    assert.deepEqual(tables(store), before)
    assert.equal(schemaVersion(store.db), LATEST)
  } finally {
    store.close()
  }
})

test("a database at version 1 or with no version at all (any runner before numbered migrations) is migrated in place", () => {
  using db = tempDb()
  const first = new Store(nodeSqlite(db.path))
  seedConversation(first, "hs_seeded_conversation", 5)
  // As if migration 1 alone had run: a pre-migration runner's tables, version reset.
  first.db.exec("DROP TABLE segments; DROP TABLE large_bodies; DROP TABLE index_outbox; DROP TABLE seal_state; DROP TABLE storage_deletions; UPDATE meta SET value = '0'")
  first.close()
  const store = new Store(nodeSqlite(db.path))
  try {
    assert.equal(store.migrationError, null)
    assert.equal(schemaVersion(store.db), LATEST)
    assert.ok(tables(store).includes("segments"))
    assert.equal(store.listTurns("hs_seeded_conversation").length, 11)
  } finally {
    store.close()
  }
})

test("a failing migration is kept for the host to report, and the database stays at the last version that completed", () => {
  const db = nodeSqlite(":memory:")
  // A table where migration 2 wants an index: its CREATE INDEX fails.
  db.exec("CREATE TABLE large_bodies (unrelated TEXT)")
  const store = new Store(db)
  try {
    assert.ok(store.migrationError instanceof Error)
    assert.equal(schemaVersion(db), 1)
    assert.ok(!store.columns("sessions").has("hot_bytes"), "migration 2 rolled back as a whole")
  } finally {
    store.close()
  }
})

test(`a database written by ${BASE} migrates with nothing lost, and ${BASE} still opens and writes the migrated database`, async (t) => {
  using base = withBaseRunner(BASE, project) ?? { run: () => "", skipped: true, [Symbol.dispose]: () => undefined }
  if ("skipped" in base) return t.skip(`${BASE} is not available here`)
  using db = tempDb()
  // The previous runner writes a conversation: turns, a task, files, a stopped message.
  base.run(
    `
    const store = new Store(nodeSqlite(dbPath))
    const id = store.putSession("hs_written_by_base", { owner: "o", title: "Old chat" }).session.id
    for (const messageId of ["a", "b", "c"]) {
      store.admitTurn({ sessionId: id, messageId, prompt: "hello " + messageId, model: null })
      store.startTranscript(id, messageId)
      store.appendMessage(id, messageId, { role: "assistant", text: "answer " + messageId, toolCalls: [] })
      store.setTurnStatus(id, messageId, "completed")
    }
    store.writeFile(id, "memory/note.md", "kept")
    store.close()
    `,
    db.path,
  )
  const store = new Store(nodeSqlite(db.path))
  try {
    assert.equal(store.migrationError, null)
    assert.equal(schemaVersion(store.db), LATEST)
    assert.deepEqual(store.listTurns("hs_written_by_base").map((turn) => turn.messageId), ["a", "b", "c"])
    assert.equal(store.readFile("hs_written_by_base", "memory/note.md"), "kept")
    // Counted in the background (never on a turn's path), then kept as it changes.
    const storage = new SessionStorage(store, memoryBlobs().store, { segments: true, hotLimitBytes: 1 << 25, segmentTargetBytes: 1 << 23, largeBodyBytes: 8192, contextCharBudget: 100_000 })
    const seal = storage.jobs().find((job) => job.name === "seal")
    assert.ok(seal && seal.nextAt() !== null)
    await seal.run()
    assert.equal(storage.inspect("hs_written_by_base").hot.bytes, store.countHotBytes("hs_written_by_base"))
    store.admitTurn({ sessionId: "hs_written_by_base", messageId: "d", prompt: "new", model: null })
    store.setTurnStatus("hs_written_by_base", "d", "completed")
  } finally {
    store.close()
  }
  // Rollback: the previous runner opens the migrated database, reads it and keeps writing.
  const seen = z
    .object({ turns: z.array(z.string()), messages: z.number(), title: z.string() })
    .parse(
      JSON.parse(
        base.run(
          `
          const store = new Store(nodeSqlite(dbPath))
          store.admitTurn({ sessionId: "hs_written_by_base", messageId: "e", prompt: "after rollback", model: null })
          store.startTranscript("hs_written_by_base", "e")
          console.log(JSON.stringify({ turns: store.listTurns("hs_written_by_base").map((turn) => turn.messageId), messages: store.messages("hs_written_by_base").length, title: store.getSession("hs_written_by_base").title }))
          store.close()
          `,
          db.path,
        ),
      ),
    )
  assert.deepEqual(seen, { turns: ["a", "b", "c", "d", "e"], messages: 7, title: "Old chat" })
  // And the new runner again after that.
  const again = new Store(nodeSqlite(db.path))
  try {
    assert.equal(again.migrationError, null)
    assert.equal(again.listTurns("hs_written_by_base").length, 5)
  } finally {
    again.close()
  }
})
