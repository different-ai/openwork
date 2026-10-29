/** Sealing old turns into segments (src/storage/): what is sealed, reads across hot and sealed, edits, deletes, export. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import type { ErrorReport, ErrorReporter } from "../src/error-reporting.js"
import type { ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { MIN_HOT_TURNS, SessionStorage, type StorageSettings } from "../src/storage/index.js"
import { Store } from "../src/store.js"
import { finishedTurn, memoryBlobs, seedConversation } from "./storage-fixture.js"

const project = join(import.meta.dirname, "..")
const token = "test-token-0123456789-0123456789-0123456789"
const limits = { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 }
const unusedModel: ModelClient = { complete: async () => { throw new Error("no model in these tests") } }
const ID = "hs_long_conversation"
const settings: StorageSettings = { segments: true, hotLimitBytes: 65_536, segmentTargetBytes: 4_096, largeBodyBytes: 1_024, contextCharBudget: 10_000 }

/** A runner world: the store on a fixed clock (so two worlds seeded alike are alike), its storage and its HTTP API. */
function world(options: { settings?: StorageSettings; path?: string; clock?: { t: number } } = {}) {
  const clock = options.clock ?? { t: 1_000 }
  const store = new Store(nodeSqlite(options.path ?? ":memory:"), () => (clock.t += 1))
  const blobs = memoryBlobs(() => clock.t)
  const reports: ErrorReport[] = []
  const errors: ErrorReporter = { enabled: true, report: async (report) => void reports.push(report) }
  const storage = new SessionStorage(store, blobs.store, options.settings ?? settings, errors, () => clock.t)
  const app = createApp({ store, runner: new Runner({ store, model: unusedModel, defaultModel: "test-model", limits, storage }), apiToken: token, storage })
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
  const read = async (query: Record<string, string> = {}) => {
    const response = await request(`/v1/sessions/${ID}?${new URLSearchParams(query).toString()}`)
    assert.equal(response.status, 200, await response.clone().text())
    return readSchema.parse(await response.json())
  }
  return { store, blobs, storage, request, read, reports, clock, [Symbol.dispose]: () => store.close() }
}
const readSchema = z
  .object({
    turns: z.array(z.object({ messageId: z.string(), status: z.string(), prompt: z.string().optional() }).loose()),
    messages: z.array(z.object({ seq: z.number(), messageId: z.string(), role: z.string() }).loose()),
    hasEarlier: z.boolean().optional(),
    finalAssistantText: z.string(),
  })
  .loose()

/** Runs the sealer job until it has nothing due. */
async function sealUntilDone(storage: SessionStorage) {
  const seal = storage.jobs().find((job) => job.name === "seal")
  assert.ok(seal)
  for (let round = 0; round < 1_000; round += 1) {
    const at = seal.nextAt()
    if (at === null || at > Date.now() + 10_000_000_000) return
    await seal.run()
    if (seal.nextAt() === null) return
  }
}
const segmentCount = (store: Store) => z.object({ n: z.number() }).parse(store.db.prepare("SELECT COUNT(*) AS n FROM segments").get()).n
const hotIds = (store: Store) => store.listTurns(ID).map((turn) => turn.messageId)

test("sealing keeps the hot database under its limit with the newest turns hot, and reads page through all of it exactly as unsealed", async () => {
  using plain = world({ settings: { ...settings, segments: false } })
  using sealed = world()
  seedConversation(plain.store, ID, 80)
  seedConversation(sealed.store, ID, 80)
  const before = sealed.store.countHotBytes(ID)
  assert.ok(before > settings.hotLimitBytes, `seeded over the limit (${before})`)
  await sealUntilDone(sealed.storage)
  await sealUntilDone(plain.storage)
  assert.equal(segmentCount(plain.store), 0, "HEADLESS_SEGMENTS=off seals nothing")
  assert.ok(segmentCount(sealed.store) >= 3, `several segments (${segmentCount(sealed.store)})`)
  const hot = sealed.storage.inspect(ID).hot.bytes ?? 0
  assert.ok(hot <= settings.hotLimitBytes, `hot bytes ${hot} under the limit`)
  assert.equal(hot, sealed.store.countHotBytes(ID), "the kept count matches the rows")
  assert.ok(hotIds(sealed.store).length >= MIN_HOT_TURNS && hotIds(sealed.store).length < 40, `${hotIds(sealed.store).length} turns stay hot`)
  assert.deepEqual(hotIds(sealed.store), hotIds(plain.store).slice(-hotIds(sealed.store).length), "the newest turns, whole")
  assert.ok(sealed.blobs.keys(`sessions/${ID}/segments/`).every((key) => /\/segments\/\d{6}\.jsonl\.gz$/.test(key)))

  // Every way a caller reads: the same answer from the sealed runner as from the unsealed one.
  const queries: Array<Record<string, string>> = [
    {},
    { turns: "5" },
    { turns: "100000" },
    { turns: "200", limit: "7" },
    { turns: "200", outputs: "none" },
    { messageId: "m005" },
    { messageId: "m002" },
    { messageId: "m002.t1", limit: "1" },
    { messageId: "m_stopped" },
    { turns: "3", before: "m010" },
    { turns: "3", before: "m001" },
    { turns: "4", before: "missing" },
  ]
  for (const query of queries) assert.deepEqual(await sealed.read(query), await plain.read(query), JSON.stringify(query))

  // Paging back to the first turn, by messageId and by seq: every turn once, in order.
  const all = plain.store.listTurns(ID).map((turn) => turn.messageId)
  const modes: Array<"messageId" | "seq"> = ["messageId", "seq"]
  for (const by of modes) {
    const seen: string[] = []
    let before: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const window = await sealed.read({ turns: "7", limit: "5000", ...(before ? { before } : {}) })
      seen.unshift(...window.turns.map((turn) => turn.messageId))
      if (!window.hasEarlier) break
      const first = window.turns[0]?.messageId ?? ""
      const seqs = window.messages.filter((message) => message.messageId === first).map((message) => message.seq)
      before = by === "seq" && seqs.length ? String(Math.min(...seqs)) : first
    }
    assert.deepEqual(seen, all, `paged back by ${by}`)
  }
  // The model's context never reads segments, and is what it was.
  assert.deepEqual(sealed.store.contextMessages(ID, "m082", 10_000), plain.store.contextMessages(ID, "m082", 10_000))
})

test("nothing running, interrupted, step-scheduled, in an open task family, at or after context_from, or among the newest turns is sealed", () => {
  const sealable = (configure: (store: Store) => void) => {
    using sealed = world()
    sealed.store.putSession(ID, { owner: "test-owner" })
    for (let index = 0; index < 45; index += 1) finishedTurn(sealed.store, ID, `m${String(index).padStart(3, "0")}`, { output: "x".repeat(1_200) })
    configure(sealed.store)
    return sealed.storage.sealable(ID, Number.POSITIVE_INFINITY)?.ids ?? []
  }
  const first = (count: number) => Array.from({ length: count }, (_, index) => `m${String(index).padStart(3, "0")}`)
  assert.deepEqual(sealable(() => undefined), first(45 - MIN_HOT_TURNS), "all but the newest 30")
  assert.deepEqual(sealable((store) => store.setTurnStatus(ID, "m005", "running")), first(5), "not a running turn, nor anything after it")
  assert.deepEqual(sealable((store) => store.setTurnStatus(ID, "m004", "interrupted", "runner_restarted")), first(4))
  assert.deepEqual(sealable((store) => store.setTurnStatus(ID, "m003", "queued")), first(3))
  assert.deepEqual(
    sealable((store) => store.db.prepare("INSERT INTO step_schedule (session_id, message_id, due_at, attempt, state) VALUES (?, 'm006', 0, 0, '{}')").run(ID)),
    first(6),
    "not a turn with a next step scheduled",
  )
  assert.deepEqual(
    sealable((store) => {
      store.admitTurn({ sessionId: ID, messageId: "m002.t1", prompt: "research", model: null, kind: "task", parent: "m002" })
    }),
    first(2),
    "not a turn whose task is still open",
  )
  assert.deepEqual(
    sealable((store) => store.setContextFrom(ID, store.turnMessages(ID, "m008")[0]?.seq ?? 0)),
    first(8),
    "nothing at or after context_from",
  )
  // Before context_from is set, nothing a budget-bounded context read still reaches.
  using everything = world({ settings: { ...settings, contextCharBudget: 10_000_000 } })
  everything.store.putSession(ID, {})
  for (let index = 0; index < 45; index += 1) finishedTurn(everything.store, ID, `m${index}`)
  assert.equal(everything.storage.sealable(ID, Number.POSITIVE_INFINITY), null, "the whole conversation still fits the model's context")
})

test("a crash between upload and commit leaves only an orphan, which orphan cleanup deletes after 24 hours", async () => {
  using sealed = world()
  seedConversation(sealed.store, ID, 50)
  const turns = hotIds(sealed.store)
  // The process "dies" at the commit after the upload: the transaction fails and the object can't be deleted either.
  const commit = sealed.store.transaction.bind(sealed.store)
  let crash = false
  sealed.store.transaction = <T>(fn: () => T): T => {
    if (crash) {
      crash = false
      throw new Error("process died")
    }
    return commit(fn)
  }
  sealed.blobs.hooks.afterPut = (key) => {
    if (key.includes("/segments/")) crash = true
  }
  sealed.blobs.hooks.failDelete = true
  await assert.rejects(sealed.storage.sealSession(ID), /process died/)
  assert.equal(segmentCount(sealed.store), 0)
  assert.deepEqual(hotIds(sealed.store), turns, "nothing left the hot database")
  const orphan = sealed.blobs.keys(`sessions/${ID}/segments/`)
  assert.equal(orphan.length, 1, "just the uploaded object")
  sealed.blobs.hooks.failDelete = false
  sealed.blobs.hooks.afterPut = undefined
  assert.equal(await sealed.storage.scanOrphans(), 0, "younger than 24 hours: kept")
  sealed.clock.t += 25 * 3_600_000
  assert.equal(await sealed.storage.scanOrphans(), 1)
  assert.deepEqual(sealed.blobs.keys(`sessions/${ID}/segments/`), [], "the orphan went")
  assert.equal(sealed.storage.inspect(ID).orphans.lastCount, 1)
  // A referenced segment is never an orphan, however old.
  assert.equal(await sealed.storage.sealSession(ID), "sealed")
  sealed.clock.t += 25 * 3_600_000
  assert.equal(await sealed.storage.scanOrphans(), 0)
  assert.equal(sealed.blobs.keys(`sessions/${ID}/segments/`).length, 1)
})

test("a checksum mismatch aborts the seal, counts the attempt with backoff and reports once it keeps failing", async () => {
  using sealed = world()
  seedConversation(sealed.store, ID, 50)
  sealed.blobs.hooks.corruptGet = (key) => key.includes("/segments/")
  const seal = sealed.storage.jobs().find((job) => job.name === "seal")
  assert.ok(seal)
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    sealed.clock.t += 3_600_000
    await seal.run()
    const state = sealed.storage.inspect(ID).sealFailures
    assert.equal(state?.attempt, attempt)
    assert.equal(state?.error, "segment_corrupt")
    assert.equal((state?.nextAttemptAt ?? 0) - sealed.clock.t, [0, 0, 0, 30_000, 120_000][attempt - 1])
  }
  assert.equal(segmentCount(sealed.store), 0)
  assert.deepEqual(sealed.blobs.keys(`sessions/${ID}/segments/`), [], "the bad upload was deleted")
  assert.deepEqual(sealed.reports.filter((report) => report.code === "seal_failed").map((report) => report.tags?.attempt), [5])
  sealed.blobs.hooks.corruptGet = undefined
  sealed.clock.t += 3_600_000
  await seal.run()
  assert.equal(segmentCount(sealed.store), 1)
  assert.equal(sealed.storage.inspect(ID).sealFailures, null, "a success clears the count")
})

test("an edit while a seal uploads aborts it, deletes the object and loses nothing", async () => {
  using sealed = world()
  seedConversation(sealed.store, ID, 50)
  sealed.blobs.hooks.afterPut = (key) => {
    if (key.includes("/segments/")) sealed.store.stripAttachments(ID, "m001") // no change: still seals
  }
  assert.equal(await sealed.storage.sealSession(ID), "sealed")
  sealed.blobs.hooks.afterPut = (key) => {
    if (key.includes("/segments/")) sealed.store.deleteTurns(ID, hotIds(sealed.store)[0] ?? "")
  }
  const target = hotIds(sealed.store)[0]
  assert.equal(await sealed.storage.sealSession(ID), "conflict")
  assert.equal(segmentCount(sealed.store), 1)
  assert.equal(sealed.blobs.keys(`sessions/${ID}/segments/`).length, 1, "the aborted upload was deleted")
  assert.ok(!hotIds(sealed.store).includes(target ?? ""), "the edit stands")
})

test("deleting or editing sealed turns rewrites their segments, as if they had never been sealed", async () => {
  using plain = world({ settings: { ...settings, segments: false } })
  using sealed = world()
  seedConversation(plain.store, ID, 60)
  seedConversation(sealed.store, ID, 60)
  await sealUntilDone(sealed.storage)
  const keysBefore = sealed.blobs.keys(`sessions/${ID}/segments/`)
  const cases: Array<[string, string]> = [
    [`/v1/sessions/${ID}/turns/m005`, "one sealed turn"],
    [`/v1/sessions/${ID}/turns/m002.t1`, "a sealed task takes its whole family"],
    [`/v1/sessions/${ID}/turns/m020?after=1`, "editing a sealed message drops everything after it, hot turns included"],
  ]
  for (const [path, label] of cases) {
    const left = await (await sealed.request(path, { method: "DELETE" })).json()
    const right = await (await plain.request(path, { method: "DELETE" })).json()
    assert.deepEqual(left, right, label)
    assert.deepEqual(await sealed.read({ turns: "200" }), await plain.read({ turns: "200" }), label)
  }
  const keysAfter = sealed.blobs.keys(`sessions/${ID}/segments/`)
  assert.ok(keysAfter.some((key) => /\.[0-9a-f]{8}\.jsonl\.gz$/.test(key)), "rewritten under a new name")
  assert.ok(keysBefore.some((key) => !keysAfter.includes(key)), "the old objects were deleted")
  assert.equal(keysAfter.length, segmentCount(sealed.store), "one object per manifest entry")
  assert.equal(await (await sealed.request(`/v1/sessions/${ID}/export`)).text(), await (await plain.request(`/v1/sessions/${ID}/export`)).text())
  assert.deepEqual((await sealed.storage.verify(ID)).filter((result) => !result.ok), [])
})

test("export is lossless with sealed turns and large bodies, and imports into a Node runner byte for byte", async () => {
  using plain = world({ settings: { ...settings, segments: false } })
  using sealed = world()
  for (const target of [plain, sealed]) {
    // A large tool output in an early (sealed) turn and a late (hot) one.
    const big = async (messageId: string) => {
      target.store.admitTurn({ sessionId: ID, messageId, prompt: "read the report", model: null })
      target.store.startTranscript(ID, messageId)
      const prepared = await target.storage.prepare(ID, { role: "tool", callId: "c", name: "read_file", output: `${messageId} `.repeat(2_000), isError: false })
      target.store.appendMessage(ID, messageId, prepared.message, prepared.body)
      target.store.setTurnStatus(ID, messageId, "completed")
    }
    target.store.putSession(ID, {})
    await big("big_early")
    seedConversation(target.store, ID, 45)
    await big("big_late")
  }
  assert.equal(sealed.blobs.keys(`sessions/${ID}/bodies/`).length, 2)
  await sealUntilDone(sealed.storage)
  assert.ok(segmentCount(sealed.store) > 0)
  assert.ok(sealed.blobs.keys(`sessions/${ID}/bodies/`).length < 2, "a sealed large body lives in its segment")
  const exported = await (await sealed.request(`/v1/sessions/${ID}/export`)).text()
  assert.equal(exported, await (await plain.request(`/v1/sessions/${ID}/export`)).text(), "the same export as if nothing had been sealed")
  assert.ok(!exported.includes("Full output kept separately"), "large bodies inline")
  using node = world({ settings: { ...settings, segments: false } })
  const imported = await node.request(`/v1/sessions/${ID}/import`, { method: "POST", body: exported })
  assert.equal(imported.status, 201, await imported.clone().text())
  assert.equal(await (await node.request(`/v1/sessions/${ID}/export`)).text(), exported)
  assert.equal(node.store.countHotBytes(ID), node.storage.inspect(ID).hot.bytes)
})

test("deleting a session removes its rows, segments, large bodies and kept files, and scrubs its bytes from the database file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-purge-"))
  try {
    const path = join(directory, "runner.sqlite")
    using sealed = world({ path })
    seedConversation(sealed.store, ID, 45)
    const witness = "purge-witness-7f3a9c"
    sealed.store.admitTurn({ sessionId: ID, messageId: "secret", prompt: `remember ${witness}`, model: null })
    sealed.store.startTranscript(ID, "secret")
    const prepared = await sealed.storage.prepare(ID, { role: "tool", callId: "c", name: "read_file", output: `${witness} `.repeat(500), isError: false })
    sealed.store.appendMessage(ID, "secret", prepared.message, prepared.body)
    sealed.store.setTurnStatus(ID, "secret", "completed")
    await sealUntilDone(sealed.storage)
    await sealed.blobs.store.put(`sessions/${ID}/fl_00000000000000000000000000000001`, new Uint8Array([1, 2, 3]), "application/pdf")
    await sealed.blobs.store.put(`sessions/${ID}/fl_00000000000000000000000000000001.preview/manifest.json`, new Uint8Array([123, 125]), "application/json")
    sealed.store.addSavedFile({ id: "fl_00000000000000000000000000000001", sessionId: ID, name: "a.pdf", mediaType: "application/pdf", size: 3, source: "user", storageKey: `sessions/${ID}/fl_00000000000000000000000000000001`, createdAt: 1, updatedAt: 1 })
    await sealed.blobs.store.put("sessions/hs_another_session/keep", new Uint8Array([1]), "text/plain")
    assert.ok(sealed.blobs.keys(`sessions/${ID}/segments/`).length > 0 && sealed.blobs.keys(`sessions/${ID}/bodies/`).length > 0)
    const response = await sealed.request(`/v1/sessions/${ID}`, { method: "DELETE" })
    assert.equal(response.status, 204)
    assert.deepEqual(sealed.blobs.keys(`sessions/${ID}/`), [], "every object of the session")
    assert.deepEqual(sealed.blobs.keys("sessions/hs_another_session/"), ["sessions/hs_another_session/keep"], "and nothing else")
    for (const table of ["turns", "messages", "segments", "large_bodies", "files", "saved_files"]) {
      assert.equal(z.object({ n: z.number() }).parse(sealed.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n, 0, table)
    }
    const deleted = sealed.store.pendingIndexUpdates(Number.MAX_SAFE_INTEGER, 10).find((update) => update.sessionId === ID)
    assert.equal(deleted?.fields.deleted, true)
    assert.equal(deleted?.fields.title, "")
    const bytes = Buffer.concat([readFileSync(path), ...(existsSync(`${path}-wal`) ? [readFileSync(`${path}-wal`)] : [])])
    assert.ok(!bytes.includes(witness), "the deleted content is not in the database file or its WAL")
    assert.equal((await sealed.request(`/v1/sessions/${ID}`, { method: "DELETE" })).status, 404)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("session CLI: inspect, seal, verify, export and delete a Node runner's session", () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-cli-"))
  try {
    const dbPath = join(directory, "runner.sqlite")
    const filesDir = join(directory, "files")
    const store = new Store(nodeSqlite(dbPath))
    seedConversation(store, ID, 45)
    store.close()
    const cli = (...args: string[]) =>
      execFileSync(join(project, "node_modules/.bin/tsx"), [join(project, "scripts/session-cli.ts"), ...args, "--db", dbPath, "--files-dir", filesDir, "--target", "4096"], {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, HEADLESS_CONTEXT_CHAR_BUDGET: "10000" },
      })
    assert.ok(z.array(z.object({ id: z.string() }).loose()).parse(JSON.parse(cli("list"))).some((row) => row.id === ID))
    const sealed = z.object({ sealed: z.number() }).parse(JSON.parse(cli("seal", ID))).sealed
    assert.ok(sealed > 0)
    const inspected = z.object({ segments: z.array(z.object({ n: z.number() }).loose()), hot: z.object({ turns: z.number() }).loose() }).loose().parse(JSON.parse(cli("inspect", ID)))
    assert.equal(inspected.segments.length, sealed)
    assert.equal(inspected.hot.turns, MIN_HOT_TURNS)
    assert.ok(z.array(z.object({ ok: z.boolean() })).parse(JSON.parse(cli("verify", ID))).every((result) => result.ok))
    assert.equal(z.object({ resealed: z.number() }).parse(JSON.parse(cli("reseal", ID))).resealed, sealed)
    const exported = z.object({ turns: z.array(z.unknown()) }).loose().parse(JSON.parse(cli("export", ID)))
    assert.equal(exported.turns.length, 45 + 6)
    assert.deepEqual(JSON.parse(cli("delete", ID, "--vacuum")), { deleted: true })
    assert.ok(!existsSync(join(filesDir, "sessions", ID)) || execFileSync("find", [join(filesDir, "sessions", ID), "-type", "f"], { encoding: "utf8" }).trim() === "")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
