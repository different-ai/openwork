import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Store } from "../src/store.js"

const owner = "test-owner"

test("SQLite state survives reopen, recovers turns, and keeps owner conversations and shared memory", () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-sql-"))
  const path = join(directory, "runner.sqlite")
  let store = new Store(nodeSqlite(path), () => 1_000)
  try {
    const main = store.createSession({ owner, ref: "main", tasks: true, files: true, computer: true })
    const side = store.createSession({ owner, ref: "side", memoryOf: main.id })
    store.writeFile(main.id, "memory/preferences.md", "Remember this ✓")
    store.admitTurn({ sessionId: main.id, messageId: "msg_1", prompt: "hello", model: null })
    store.startTranscript(main.id, "msg_1")
    store.startTranscript(main.id, "msg_1") // Resume is idempotent.
    store.appendMessage(main.id, "msg_1", { role: "assistant", text: "answer", toolCalls: [] })
    store.setTurnStatus(main.id, "msg_1", "running")
    store.admitTurn({ sessionId: side.id, messageId: "msg_2", prompt: "continue", model: null })
    store.admitTurn({ sessionId: main.id, messageId: "msg_1.task_1", prompt: "research", model: null, kind: "task", parent: "msg_1", title: "Research" })
    store.addSavedFile({ id: "file_1", sessionId: main.id, name: "note.txt", mediaType: "text/plain", size: 3, source: "user", storageKey: "test/note", createdAt: 1_000, updatedAt: 1_000 })
    store.close()
    store = new Store(nodeSqlite(path), () => 2_000)
    assert.equal(store.recoverInterruptedTurns(), 3)
    assert.equal(store.recoverInterruptedTurns(), 0)
    assert.equal(store.getTurn(main.id, "msg_1")?.status, "interrupted")
    assert.equal(store.getTurn(main.id, "msg_1")?.error, "runner_restarted")
    assert.deepEqual(store.messages(main.id).map((entry) => entry.message.role), ["user", "assistant"])
    assert.equal(store.getSession(side.id)?.memoryOf, main.id)
    assert.equal(store.readFile(main.id, "memory/preferences.md"), "Remember this ✓")
    assert.equal(store.listFiles(main.id)[0]?.size, Buffer.byteLength("Remember this ✓"))
    assert.equal(store.listSessions(owner, 10).length, 2)
    assert.equal(store.listSessions("another-owner", 10).length, 0)
    assert.equal(store.recentTasks(main.id, 5)[0]?.title, "Research")
    assert.equal(store.getSavedFile(main.id, "file_1")?.storageKey, "test/note")
    assert.equal(store.deleteSession(main.id), true)
    assert.equal(store.deleteSession(main.id), false)
    assert.deepEqual(store.messages(main.id), [])
    assert.deepEqual(store.listTurns(main.id), [])
    assert.deepEqual(store.listFiles(main.id), [])
    assert.deepEqual(store.listSavedFiles(main.id), [])
    assert.equal(store.getSession(side.id)?.id, side.id)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("transactions roll back and the connection remains usable", () => {
  const store = new Store(nodeSqlite(":memory:"))
  try {
    const session = store.createSession({ owner })
    assert.throws(() => store.transaction(() => {
      store.writeFile(session.id, "notes/rolled-back.md", "not committed")
      store.setTitle(session.id, "not committed")
      throw new Error("rollback witness")
    }), /rollback witness/)
    assert.equal(store.readFile(session.id, "notes/rolled-back.md"), null)
    assert.equal(store.getSession(session.id)?.title, "Untitled")
    store.transaction(() => store.writeFile(session.id, "notes/committed.md", "committed"))
    assert.equal(store.readFile(session.id, "notes/committed.md"), "committed")
  } finally {
    store.close()
  }
})

test("bounded context reads release their cursor before the next write", () => {
  const store = new Store(nodeSqlite(":memory:"))
  try {
    const session = store.createSession({})
    for (let index = 0; index < 20; index++) {
      const messageId = `msg_${index}`
      store.admitTurn({ sessionId: session.id, messageId, prompt: `prompt ${index}`, model: null })
      store.startTranscript(session.id, messageId)
      store.appendMessage(session.id, messageId, { role: "assistant", text: "a".repeat(1_000), toolCalls: [] })
    }
    const context = store.contextMessages(session.id, "msg_19", 1_000)
    assert.equal(context.partial, true)
    assert.ok(context.rows.length < 40)
    assert.equal(context.rows[0]?.message.role, "user")
    store.transaction(() => store.setContextFrom(session.id, context.rows[0].seq))
    assert.equal(store.contextMessages(session.id, "msg_19", 1_000).rows.length, context.rows.length)
  } finally {
    store.close()
  }
})

test("the original schema migrates without losing sessions or scratch files", () => {
  const db = nodeSqlite(":memory:")
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE files (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, path TEXT NOT NULL, content TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, path));
  `)
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run("hs_legacy", "Existing chat", "instructions", 100, 200)
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?)").run("hs_legacy", "memory/note.md", "existing", 8, 200)
  const store = new Store(db)
  try {
    store.migrate() // Schema initialization is safe to repeat.
    assert.equal(store.getSession("hs_legacy")?.title, "Existing chat")
    assert.equal(store.getSession("hs_legacy")?.owner, null)
    assert.equal(store.getSession("hs_legacy")?.files, false)
    assert.equal(store.readFile("hs_legacy", "memory/note.md"), "existing")
    store.admitTurn({ sessionId: "hs_legacy", messageId: "msg_new", prompt: "hello", model: null })
    store.startTranscript("hs_legacy", "msg_new")
    assert.equal(store.messages("hs_legacy").length, 1)
  } finally {
    store.close()
  }
})
