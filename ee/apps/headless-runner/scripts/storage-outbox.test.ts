/** The Den index outbox (src/storage/index-outbox.ts): written with every listed change, in the same transaction. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { nodeSqlite } from "../src/node-sqlite.js"
import { indexFieldsSchema, SessionStorage } from "../src/storage/index.js"
import { Store } from "../src/store.js"
import { finishedTurn, memoryBlobs } from "./storage-fixture.js"

function world() {
  const clock = { t: 10_000 }
  const store = new Store(nodeSqlite(":memory:"), () => (clock.t += 1))
  return { store, clock, [Symbol.dispose]: () => store.close() }
}
const row = (store: Store, sessionId: string) => {
  const value = z
    .object({ version: z.number(), fields: z.string(), attempt: z.number(), next_attempt_at: z.number(), created_at: z.number() })
    .safeParse(store.db.prepare("SELECT version, fields, attempt, next_attempt_at, created_at FROM index_outbox WHERE session_id = ?").get(sessionId))
  return value.success ? { ...value.data, fields: indexFieldsSchema.parse(JSON.parse(value.data.fields)) } : null
}

test("every listed change queues a fresh snapshot with a growing version: create, rename, turn start and end, size steps, seal, delete", async () => {
  using w = world()
  const { store } = w
  const id = store.createSession({ owner: "o", title: "First" }).id
  const created = row(store, id)
  assert.equal(created?.version, 1)
  assert.deepEqual({ ...created?.fields, createdAt: 0, updatedAt: 0 }, { title: "First", createdAt: 0, updatedAt: 0, hotBytes: 0, segmentCount: 0, totalBytes: 0, activeTurnSince: null, deleted: false })
  store.putSession(id, { title: "Renamed" })
  assert.equal(row(store, id)?.version, 2)
  assert.equal(row(store, id)?.fields.title, "Renamed")
  store.putSession(id, { title: "Renamed" })
  assert.equal(row(store, id)?.version, 2, "no change, no update")
  store.setTitle(id, "Named after the answer")
  assert.equal(row(store, id)?.version, 3)
  // A turn starts and ends.
  store.admitTurn({ sessionId: id, messageId: "a", prompt: "hello", model: null })
  assert.equal(row(store, id)?.version, 3, "admitted (queued) is not a start")
  store.setTurnStatus(id, "a", "running")
  const running = row(store, id)
  assert.equal(running?.version, 4)
  assert.ok((running?.fields.activeTurnSince ?? 0) > 0)
  store.startTranscript(id, "a")
  store.setTurnStatus(id, "a", "completed")
  assert.equal(row(store, id)?.version, 5)
  assert.equal(row(store, id)?.fields.activeTurnSince, null)
  assert.equal(row(store, id)?.fields.hotBytes, store.countHotBytes(id))
  // Size steps: every 1 MiB of hot bytes.
  const big = "x".repeat(600 * 1024)
  store.appendMessage(id, "a", { role: "assistant", text: big, toolCalls: [] })
  assert.equal(row(store, id)?.version, 5, "under the first MiB")
  store.appendMessage(id, "a", { role: "assistant", text: big, toolCalls: [] })
  assert.equal(row(store, id)?.version, 6, "crossed 1 MiB")
  assert.ok((row(store, id)?.fields.hotBytes ?? 0) > 1024 * 1024)
  // Sealed: the segment counts, the hot bytes drop.
  for (let index = 0; index < 40; index += 1) finishedTurn(store, id, `t${index}`, { output: "y".repeat(2_000) })
  const storage = new SessionStorage(store, memoryBlobs().store, { segments: true, hotLimitBytes: 65_536, segmentTargetBytes: 1 << 30, largeBodyBytes: 8_192, contextCharBudget: 10_000 })
  const versionBefore = row(store, id)?.version ?? 0
  assert.equal(await storage.sealSession(id), "sealed")
  const sealed = row(store, id)
  assert.ok((sealed?.version ?? 0) > versionBefore)
  assert.equal(sealed?.fields.segmentCount, 1)
  assert.ok((sealed?.fields.totalBytes ?? 0) > (sealed?.fields.hotBytes ?? 0))
  // Deleted: the last word, with the session's capability kept for the flusher.
  store.setIndexCapability(id, "test-capability")
  await storage.deleteSession(id)
  const [deleted] = store.pendingIndexUpdates(Number.MAX_SAFE_INTEGER, 10)
  assert.equal(deleted?.sessionId, id)
  assert.equal(deleted?.capability, "test-capability")
  assert.deepEqual({ deleted: deleted?.fields.deleted, title: deleted?.fields.title, hotBytes: deleted?.fields.hotBytes }, { deleted: true, title: "", hotBytes: 0 })
  assert.ok((deleted?.version ?? 0) > (sealed?.version ?? 0))
})

test("the outbox entry is part of the change's transaction: a rolled-back change leaves no update", () => {
  using w = world()
  const { store } = w
  const id = store.createSession({ title: "Kept" }).id
  assert.throws(() =>
    store.transaction(() => {
      store.setTitle(id, "Never")
      store.admitTurn({ sessionId: id, messageId: "a", prompt: "p", model: null })
      store.setTurnStatus(id, "a", "running")
      throw new Error("rollback")
    }),
  )
  assert.equal(row(store, id)?.version, 1)
  assert.equal(row(store, id)?.fields.title, "Kept")
  assert.equal(store.getSession(id)?.title, "Kept")
})

test("the flusher's methods: pending, ack only the version sent, defer with attempts, next due, drop old, snapshot all", () => {
  using w = world()
  const { store } = w
  const a = store.createSession({ title: "A" }).id
  const b = store.createSession({ title: "B" }).id
  // Without a capability nothing can be sent: it doesn't make the cell wake.
  assert.equal(store.nextIndexUpdateAt(), null)
  store.setIndexCapability(a, "cap-a")
  const now = w.clock.t + 1
  assert.ok((store.nextIndexUpdateAt() ?? Number.POSITIVE_INFINITY) <= now)
  const pending = store.pendingIndexUpdates(now, 10)
  assert.deepEqual(pending.map((update) => [update.sessionId, update.capability]), [[a, "cap-a"], [b, null]], "sendable first")
  // A newer snapshot replaced the one sent: the ack leaves it.
  const sent = pending[0]?.version ?? 0
  store.setTitle(a, "A2")
  store.ackIndexUpdate(a, sent)
  assert.equal(row(store, a)?.fields.title, "A2")
  store.ackIndexUpdate(a, row(store, a)?.version ?? 0)
  assert.equal(row(store, a), null)
  // Deferred: counted, and not due until then.
  store.setTitle(a, "A3")
  const version = row(store, a)?.version ?? 0
  store.deferIndexUpdate(a, version, now + 30_000)
  assert.equal(row(store, a)?.attempt, 1)
  assert.equal(store.nextIndexUpdateAt(), now + 30_000)
  assert.deepEqual(store.pendingIndexUpdates(now, 10).map((update) => update.sessionId), [b])
  store.deferIndexUpdate(a, version - 1, now + 90_000)
  assert.equal(row(store, a)?.attempt, 1, "a stale version is not deferred")
  // Versions only grow, also after an ack deleted the row.
  store.ackIndexUpdate(a, version)
  store.setTitle(a, "A4")
  assert.ok((row(store, a)?.version ?? 0) > version)
  // Old rows go; a daily snapshot queues every session again.
  assert.equal(store.dropIndexUpdatesBefore(w.clock.t + 1_000), 2)
  assert.equal(store.pendingIndexUpdates(Number.MAX_SAFE_INTEGER, 10).length, 0)
  store.indexSnapshotAll(w.clock.t)
  assert.deepEqual(store.pendingIndexUpdates(Number.MAX_SAFE_INTEGER, 10).map((update) => update.sessionId).sort(), [a, b].sort())
})
