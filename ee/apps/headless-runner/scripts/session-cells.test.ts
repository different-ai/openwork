/**
 * Session cells, host-neutral (src/cells.ts, src/cells-store.ts, src/memory.ts): an owner cell and session cells as
 * separate databases joined by an in-process cell call, the same internal routes the celld host serves. The real
 * runtime's routing and owner checks are covered by owner-cells-e2e.ts.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import { CellsStore } from "../src/cells-store.js"
import { CellCallError, SessionCells, ownerCellName, sessionCellName, type CellCall, type CellIdentity, type InternalPath } from "../src/cells.js"
import { runFileTool } from "../src/files.js"
import { localMemory, MemoryUnavailableError } from "../src/memory.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { SessionStorage, type StorageSettings } from "../src/storage/index.js"
import { Store } from "../src/store.js"
import { memoryBlobs, toolMessage } from "./storage-fixture.js"

const token = "test-token-0123456789-0123456789-0123456789"
const owner = "wb:test-person"
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 6, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
const unusedModel: ModelClient = { complete: async () => { throw new Error("no model here") } }

/** One cell: its database and its session-cells logic, named like the celld host names it. */
type Cell = { name: string; store: Store; cells: CellsStore; host: SessionCells; moved: string[]; storage: SessionStorage }
const storageSettings: StorageSettings = { segments: true, hotLimitBytes: 65_536, segmentTargetBytes: 4_096, largeBodyBytes: 1_024, contextCharBudget: 10_000 }

/** Cells joined by an in-process call; `fail` makes a call throw (a crash, or a cell that doesn't answer). */
function world() {
  const cells = new Map<string, Cell>()
  // One files bucket for every cell, as on celld: a moved chat's objects keep their keys.
  const bucket = memoryBlobs()
  const calls: Array<{ from: string; to: string; path: InternalPath }> = []
  let fail: ((to: string, path: InternalPath, count: number) => boolean) | null = null
  let pauseMs = 0
  const identity = (name: string): CellIdentity => name.startsWith("owner:") ? { kind: "owner", owner: name.slice(6) } : name.startsWith("session:") ? { kind: "session", sessionId: name.slice(8) } : { kind: "service" }
  function cell(name: string): Cell {
    const existing = cells.get(name)
    if (existing) return existing
    const store = new Store(nodeSqlite(":memory:"))
    const storage = new SessionStorage(store, bucket.store, storageSettings)
    const host = new SessionCells({ store, cells: CellsStore.of(store), self: () => identity(name), call: callFrom(name), moved: (id) => created.moved.push(id), handedOver: () => storage.deletionsChanged(), pauseMs })
    const created: Cell = { name, store, cells: CellsStore.of(store), host, moved: [], storage }
    cells.set(name, created)
    return created
  }
  /** A fresh SessionCells over the same database: what a cell is after its process was killed. */
  function restart(name: string) {
    const existing = cell(name)
    existing.host = new SessionCells({ store: existing.store, cells: CellsStore.of(existing.store), self: () => identity(name), call: callFrom(name), moved: (id) => existing.moved.push(id), handedOver: () => existing.storage.deletionsChanged(), pauseMs })
    return existing
  }
  function callFrom(from: string): CellCall {
    return async (to, path, body) => {
      calls.push({ from, to, path })
      if (fail?.(to, path, calls.length)) throw new CellCallError(503, "unavailable")
      // Through JSON, as over HTTP.
      const answer = await cell(to).host.handle(from, path, JSON.parse(JSON.stringify(body)))
      if (answer.status >= 400) throw new CellCallError(answer.status, z.object({ error: z.string() }).parse(answer.body).error)
      return JSON.parse(JSON.stringify(answer.body))
    }
  }
  return {
    cell,
    restart,
    bucket,
    calls,
    failWhen: (check: typeof fail) => { fail = check },
    setPause: (ms: number) => { pauseMs = ms },
    [Symbol.dispose]: () => { for (const entry of cells.values()) entry.store.close() },
  }
}

function finishedTurn(store: Store, sessionId: string, messageId: string, answer: string) {
  store.admitTurn({ sessionId, messageId, prompt: `prompt for ${messageId}`, model: "test-model" })
  store.startTranscript(sessionId, messageId)
  store.appendMessage(sessionId, messageId, { role: "assistant", text: answer, toolCalls: [] })
  store.setTurnStatus(sessionId, messageId, "completed")
}

/** An owner cell as Workbot leaves it today: a main chat with memory, side chats sharing it, a kept file, tasks. */
function seedOwner(store: Store) {
  const main = store.putSession("hs_wb_main000000000000", { owner, ref: "main", tasks: true, files: true }).session.id
  const side = store.putSession("hs_wbs_side00000000000", { owner, ref: "side-1", autoTitle: true, memoryOf: main }).session.id
  const quiet = store.putSession("hs_wbs_quiet0000000000", { owner, ref: "side-2", memoryOf: main }).session.id
  finishedTurn(store, main, "msg_1", "First answer.")
  store.admitTurn({ sessionId: main, messageId: "msg_1.t1", prompt: "a task", model: "test-model", kind: "task", parent: "msg_1", title: "Research" })
  store.setTurnStatus(main, "msg_1.t1", "completed")
  finishedTurn(store, side, "msg_s", "Side answer.")
  store.setTitle(side, "Side chat")
  store.writeFile(main, "memory/about-me.md", "Prefers mornings ✓")
  store.writeFile(main, "drafts/reply.md", "Dear team,")
  store.writeFile(side, "notes.md", "side notes")
  store.addSavedFile({ id: "fl_00000000000000000000000000000001", sessionId: main, name: "plan.pdf", mediaType: "application/pdf", size: 42, source: "agent", storageKey: `sessions/${main}/fl_00000000000000000000000000000001`, createdAt: 1_000, updatedAt: 1_500 })
  store.setContextFrom(main, 2)
  return { main, side, quiet }
}

async function runSplit(cell: Cell, maxRuns = 20) {
  const job = cell.host.splitJob()
  for (let run = 0; run < maxRuns; run += 1) {
    const at = job.nextAt()
    if (at === null) return run
    if (at > Date.now()) return run
    await job.run()
  }
  return maxRuns
}

const listedIds = async (app: ReturnType<typeof createApp>, who = owner) =>
  z.object({ sessions: z.array(z.object({ id: z.string() })) }).parse(await (await app.request(`/v1/sessions?owner=${encodeURIComponent(who)}`, { headers: { authorization: `Bearer ${token}` } })).json()).sessions.map((session) => session.id)

function appFor(store: Store, cells?: CellsStore) {
  return createApp({ store, runner: new Runner({ store, model: unusedModel, defaultModel: "test-model", limits }), apiToken: token, cells })
}
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" }

test("Node host: hs_c_ ids are ordinary, memoryScope is strict and needs an owner, and the split is a no-op", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  const app = appFor(store)
  const id = `hs_c_${"a".repeat(32)}`
  const created = await app.request(`/v1/sessions/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ owner, memoryScope: "owner" }) })
  assert.equal(created.status, 201)
  assert.equal(z.object({ memoryScope: z.literal("owner") }).loose().parse(await created.json()).memoryScope, "owner")
  assert.equal((await app.request(`/v1/sessions/hs_c_${"b".repeat(32)}`, { method: "PUT", headers: auth, body: JSON.stringify({ owner, memoryScope: "session" }) })).status, 400)
  const ownerless = await app.request(`/v1/sessions/hs_c_${"c".repeat(32)}`, { method: "PUT", headers: auth, body: JSON.stringify({ memoryScope: "owner" }) })
  assert.equal(ownerless.status, 400)
  assert.equal(z.object({ error: z.string() }).parse(await ownerless.json()).error, "owner_required")
  const both = await app.request("/v1/sessions", { method: "POST", headers: auth, body: JSON.stringify({ owner, memoryScope: "owner", memoryOf: id }) })
  assert.equal(both.status, 400)
  const split = await app.request("/v1/owner/split", { method: "POST", headers: auth })
  assert.equal(split.status, 200)
  assert.deepEqual(await split.json(), { split: "not_needed" })
  store.close()
})

test("owner-scoped memory is shared by an owner's chats (Node), and only theirs; memoryOf works as before", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  const cells = CellsStore.of(store)
  const memory = localMemory(store, cells)
  const first = store.putSession(`hs_c_${"1".repeat(32)}`, { owner, memoryScope: "owner" }).session
  const second = store.putSession(`hs_c_${"2".repeat(32)}`, { owner, memoryScope: "owner" }).session
  const stranger = store.putSession(`hs_c_${"3".repeat(32)}`, { owner: "wb:someone-else", memoryScope: "owner" }).session
  const wrote = await runFileTool(store, first.id, "write_file", { path: "memory/me.md", content: "likes tea" }, memory(first))
  assert.equal(wrote.isError, false)
  assert.equal((await runFileTool(store, second.id, "read_file", { path: "memory/me.md" }, memory(second))).output, "likes tea")
  assert.equal((await runFileTool(store, stranger.id, "read_file", { path: "memory/me.md" }, memory(stranger))).isError, true)
  // Not in either conversation's own files, and other files stay each conversation's own.
  assert.equal(store.readFile(first.id, "memory/me.md"), null)
  await runFileTool(store, first.id, "write_file", { path: "draft.md", content: "x" }, memory(first))
  assert.equal((await runFileTool(store, second.id, "read_file", { path: "draft.md" }, memory(second))).isError, true)
  assert.match((await runFileTool(store, second.id, "list_files", {}, memory(second))).output, /memory\/me\.md\t9 bytes/)

  // Legacy memoryOf, unchanged: the side chat reads and writes the main chat's memory/ files.
  const main = store.putSession("hs_legacy_main_0001", { owner: "wb:legacy" }).session
  const side = store.putSession("hs_legacy_side_0001", { owner: "wb:legacy", memoryOf: main.id }).session
  await runFileTool(store, side.id, "write_file", { path: "memory/x.md", content: "shared" }, memory(side))
  assert.equal(store.readFile(main.id, "memory/x.md"), "shared")
  assert.equal(memory(main), null)
  store.close()
})

test("the model sees owner-scoped memory once per turn, read through MemoryAccess", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  const cells = CellsStore.of(store)
  cells.writeOwnerMemory(owner, "memory/about.md", "Works on Fridays")
  const systems: string[] = []
  let lists = 0
  const base = localMemory(store, cells)
  const model: ModelClient = {
    async complete(request: ModelRequest) {
      systems.push(request.system)
      const answered = request.messages.at(-1)?.role === "tool"
      return answered ? { text: "Done.", toolCalls: [], usage } : { text: "", toolCalls: [{ id: "c1", name: "read_file", input: { path: "memory/about.md" } }], usage }
    },
  }
  const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "k", limits, memory: (session) => {
    const access = base(session)
    return access && { ...access, list: async () => { lists += 1; return access.list() } }
  } })
  const session = store.putSession(`hs_c_${"d".repeat(32)}`, { owner, memoryScope: "owner" }).session
  runner.send({ sessionId: session.id, messageId: "m1", prompt: "What do you know?", credentials: {} })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "m1")?.status, "completed")
  assert.equal(systems.length, 2)
  assert.ok(systems.every((system) => system.includes("Works on Fridays")))
  assert.equal(lists, 1, "one memory read for the turn's context, not one per step")
  store.close()
})

test("the owner's memory takes over a shared one once (adoption), and memoryOf to it means the owner's memory", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  const cells = CellsStore.of(store)
  const { main, side, quiet } = seedOwner(store)
  store.putSession("hs_other_owner_000001", { owner: "wb:other" })
  assert.deepEqual(cells.ownerMemoryFiles(owner).map(({ path, content }) => ({ path, content })), [{ path: "memory/about-me.md", content: "Prefers mornings ✓" }])
  for (const id of [main, side, quiet]) {
    assert.equal(store.getSession(id)?.memoryScope, "owner")
    assert.equal(store.getSession(id)?.memoryOf, null)
  }
  assert.equal(store.readFile(main, "memory/about-me.md"), null)
  assert.equal(store.readFile(main, "drafts/reply.md"), "Dear team,")
  // Workbot (flag off) keeps sending memoryOf: an existing chat stays on the owner's memory; a new one joins it.
  const app = appFor(store, cells)
  assert.equal((await app.request(`/v1/sessions/${side}`, { method: "PUT", headers: auth, body: JSON.stringify({ owner, memoryOf: main }) })).status, 200)
  assert.equal(store.getSession(side)?.memoryScope, "owner")
  const fresh = await app.request("/v1/sessions/hs_wbs_new0000000000", { method: "PUT", headers: auth, body: JSON.stringify({ owner, memoryOf: main }) })
  assert.equal(fresh.status, 201)
  assert.equal(store.getSession("hs_wbs_new0000000000")?.memoryScope, "owner")
  // The files API still shows a chat's memory, now read from the owner's.
  const content = await app.request(`/v1/sessions/${main}/files/content?path=memory/about-me.md`, { headers: auth })
  assert.equal(await content.text(), "Prefers mornings ✓")
  const listed = z.object({ files: z.array(z.object({ path: z.string() })) }).parse(await (await app.request(`/v1/sessions/${side}/files`, { headers: auth })).json())
  assert.deepEqual(listed.files.map((file) => file.path), ["memory/about-me.md", "notes.md"])
  // Idempotent.
  cells.adoptOwnerMemory(owner)
  assert.equal(cells.ownerMemoryFiles(owner).length, 1)
  store.close()
})

test("a session cell keeps its owner's directory current; listing merges legacy and session-cell chats", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const legacy = ownerCell.store.putSession("hs_wb_legacy00000000", { owner, ref: "main" }).session.id
  finishedTurn(ownerCell.store, legacy, "m0", "old")
  const id = `hs_c_${"e".repeat(32)}`
  const sessionCell = cells.cell(sessionCellName(id))
  sessionCell.cells.claimCellOwner(owner)
  sessionCell.store.putSession(id, { owner, ref: "chat-e", title: "New chat", memoryScope: "owner" })
  assert.equal(await sessionCell.host.syncDirectory(), true)
  const app = appFor(ownerCell.store, ownerCell.cells)
  // Listed only once it has a message, as legacy chats.
  assert.deepEqual(await listedIds(app), [legacy])
  finishedTurn(sessionCell.store, id, "m1", "hello")
  await sessionCell.host.syncDirectory()
  assert.deepEqual(await listedIds(app), [id, legacy])
  // The owner cell is down: the entry waits in the outbox and goes out from the job later.
  sessionCell.store.setTitle(id, "Renamed")
  cells.failWhen((to) => to === ownerCell.name)
  assert.equal(await sessionCell.host.syncDirectory(), true)
  assert.notEqual(sessionCell.cells.pendingDirectory(), null)
  cells.failWhen(null)
  const job = sessionCell.host.directoryJob()
  assert.ok((job.nextAt() ?? Infinity) <= Date.now())
  await job.run()
  assert.equal(sessionCell.cells.pendingDirectory(), null)
  assert.equal(ownerCell.cells.directorySessions(owner, 10)[0]?.title, "Renamed")
  // A stale version never overwrites a newer one.
  await ownerCell.host.handle(sessionCell.name, "/internal/owner-directory", { sessionId: id, version: 1, entry: { title: "Stale", ref: null, createdAt: 0, updatedAt: 0, hasTurns: true, deleted: false } })
  assert.equal(ownerCell.cells.directorySessions(owner, 10)[0]?.title, "Renamed")
  // Only the chat's own cell keeps its entry.
  const forged = await ownerCell.host.handle(sessionCellName(`hs_c_${"f".repeat(32)}`), "/internal/owner-directory", { sessionId: id, version: 99, entry: { title: "Forged", ref: null, createdAt: 0, updatedAt: 0, hasTurns: true, deleted: true } })
  assert.equal(forged.status, 403)
  // Deleted: gone from the list, the directory keeps a tombstone.
  sessionCell.store.deleteSession(id)
  await sessionCell.host.syncDirectory()
  assert.deepEqual(await listedIds(app), [legacy])
})

test("a session cell reads and writes the owner's memory in the owner cell; unreachable memory fails visibly", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const ids = [`hs_c_${"4".repeat(32)}`, `hs_c_${"5".repeat(32)}`]
  const sessions = await Promise.all(ids.map(async (id) => {
    const cell = cells.cell(sessionCellName(id))
    cell.cells.claimCellOwner(owner)
    const session = cell.store.putSession(id, { owner, memoryScope: "owner" }).session
    // Created: listed in the owner's directory right away, as the celld host does.
    assert.equal(await cell.host.syncDirectory(), true)
    return { cell, session }
  }))
  const [first, second] = sessions
  assert.ok(first && second)
  const memoryOf = (entry: typeof first) => entry.cell.host.memoryResolver(localMemory(entry.cell.store, entry.cell.cells))(entry.session)
  assert.equal((await runFileTool(first.cell.store, first.session.id, "write_file", { path: "memory/team.md", content: "Ana, Bo" }, memoryOf(first))).isError, false)
  assert.equal((await runFileTool(second.cell.store, second.session.id, "read_file", { path: "memory/team.md" }, memoryOf(second))).output, "Ana, Bo")
  assert.equal(ownerCell.cells.readOwnerMemory(owner, "memory/team.md"), "Ana, Bo")
  assert.equal(first.cell.store.readFile(first.session.id, "memory/team.md"), null)
  // The owner cell doesn't answer: the context build throws (the step fails retryably), a file tool reports an error.
  cells.failWhen((to) => to === ownerCell.name)
  await assert.rejects(memoryOf(second)?.list() ?? Promise.resolve(), MemoryUnavailableError)
  const failed = await runFileTool(second.cell.store, second.session.id, "read_file", { path: "memory/team.md" }, memoryOf(second))
  assert.equal(failed.isError, true)
  assert.match(failed.output, /Memory didn't respond/)
  cells.failWhen(null)
  // Only owner cells answer memory calls, and only from a session cell.
  assert.equal((await second.cell.host.handle(first.cell.name, "/internal/memory", { op: "list" })).status, 404)
  assert.equal((await ownerCell.host.handle(ownerCellName("wb:someone"), "/internal/memory", { op: "list" })).status, 404)
})

test("the owner cell answers memory calls only from its own chats' cells: in its directory, or moved there", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  ownerCell.cells.writeOwnerMemory(owner, "memory/secret.md", "only mine")
  const ask = (from: string) => ownerCell.host.handle(from, "/internal/memory", { op: "read", path: "memory/secret.md" })
  // Another owner's chat (its cell proved who it is, but it isn't this owner's), and one never listed here.
  const stranger = `hs_c_${"6".repeat(32)}`
  const strangerCell = cells.cell(sessionCellName(stranger))
  strangerCell.cells.claimCellOwner("wb:someone-else")
  strangerCell.store.putSession(stranger, { owner: "wb:someone-else", memoryScope: "owner" })
  await strangerCell.host.syncDirectory()
  assert.equal((await ask(sessionCellName(stranger))).status, 404)
  assert.equal((await ask(sessionCellName(`hs_c_${"7".repeat(32)}`))).status, 404)
  // Listed: answered. Deleted: refused again.
  const mine = `hs_c_${"8".repeat(32)}`
  const mineCell = cells.cell(sessionCellName(mine))
  mineCell.cells.claimCellOwner(owner)
  mineCell.store.putSession(mine, { owner, memoryScope: "owner" })
  await mineCell.host.syncDirectory()
  assert.deepEqual((await ask(sessionCellName(mine))).body, { content: "only mine" })
  mineCell.store.deleteSession(mine)
  await mineCell.host.syncDirectory()
  assert.equal((await ask(sessionCellName(mine))).status, 404)
  // A chat whose directory entry is still in its outbox (the owner cell was down at creation): its first memory read
  // sends the entry, then is answered.
  const late = `hs_c_${"9".repeat(32)}`
  const lateCell = cells.cell(sessionCellName(late))
  lateCell.cells.claimCellOwner(owner)
  const session = lateCell.store.putSession(late, { owner, memoryScope: "owner" }).session
  cells.failWhen((to, path) => to === ownerCell.name && path === "/internal/owner-directory")
  await lateCell.host.syncDirectory()
  cells.failWhen(null)
  const memory = lateCell.host.memoryResolver(localMemory(lateCell.store, lateCell.cells))(session)
  assert.equal(await memory?.read("memory/secret.md"), "only mine")
  // A moved legacy chat is answered through its forwarding row.
  seedOwner(ownerCell.store)
  ownerCell.host.startSplit()
  await runSplit(ownerCell)
  assert.deepEqual((await ask(sessionCellName("hs_wb_main000000000000"))).body, { content: "only mine" })
})

test("the owner split moves every legacy chat losslessly, forwards it, moves memory, and is idempotent", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const { main, side, quiet } = seedOwner(ownerCell.store)
  // The split moves the shared memory to the owner first; every chat is then copied exactly as it is.
  ownerCell.cells.adoptOwnerMemory(owner)
  const before = new Map([main, side, quiet].map((id) => [id, ownerCell.store.exportConversation(id)]))
  const prints = new Map([main, side, quiet].map((id) => [id, ownerCell.cells.fingerprint(id)]))
  assert.equal(ownerCell.host.startSplit(), "started")
  assert.equal(ownerCell.host.startSplit(), "running")
  await runSplit(ownerCell)
  for (const id of [main, side, quiet]) {
    const target = cells.cell(sessionCellName(id))
    assert.equal(ownerCell.store.getSession(id), null, `${id} left the owner cell`)
    assert.deepEqual(ownerCell.cells.forwardOf(id), { owner, cell: sessionCellName(id) })
    assert.equal(target.cells.cellOwner(), owner)
    assert.equal(target.cells.fingerprint(id), prints.get(id), `${id} copied row for row`)
    const exported = target.store.exportConversation(id)
    const original = before.get(id)
    assert.ok(exported && original)
    assert.deepEqual(exported, original)
    assert.equal(target.store.getSession(id)?.memoryScope, "owner")
  }
  assert.equal(cells.cell(sessionCellName(main)).store.readFile(main, "drafts/reply.md"), "Dear team,")
  assert.equal(cells.cell(sessionCellName(main)).store.listSavedFiles(main)[0]?.id, "fl_00000000000000000000000000000001")
  assert.deepEqual(ownerCell.cells.ownerMemoryFiles(owner).map(({ path, content }) => ({ path, content })), [{ path: "memory/about-me.md", content: "Prefers mornings ✓" }])
  // The owner's list is the same chats as before (quiet has no message, so it isn't listed, as before).
  assert.deepEqual(new Set(await listedIds(appFor(ownerCell.store, ownerCell.cells))), new Set([main, side]))
  assert.equal(ownerCell.host.startSplit(), "done")
  assert.equal(await runSplit(ownerCell), 0)
  assert.deepEqual(z.object({ n: z.number() }).parse(ownerCell.store.db.prepare("SELECT COUNT(*) AS n FROM messages").get()), { n: 0 })
  // A moved chat's directory entry follows its own cell from now on.
  const moved = cells.cell(sessionCellName(side))
  moved.store.setTitle(side, "Side chat, renamed")
  await moved.host.syncDirectory()
  assert.equal(ownerCell.cells.directorySessions(owner, 10).find((entry) => entry.id === side)?.title, "Side chat, renamed")
  // An owner with nothing to move.
  const empty = cells.cell(ownerCellName("wb:nobody"))
  assert.equal(empty.host.startSplit(), "not_needed")
})

test("the split never moves a busy chat, and starts over when a chat changes while it is copied", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const { main, side, quiet } = seedOwner(ownerCell.store)
  ownerCell.store.admitTurn({ sessionId: quiet, messageId: "running", prompt: "busy", model: null })
  ownerCell.store.setTurnStatus(quiet, "running", "running")
  ownerCell.host.startSplit()
  // The main chat changes during its copy (a rename arrives between two import calls).
  let renamed = false
  cells.failWhen((to, path) => {
    if (!renamed && to === sessionCellName(main) && path === "/internal/import/rows") {
      renamed = true
      ownerCell.store.setTitle(main, "Renamed mid-copy")
    }
    return false
  })
  await runSplit(ownerCell)
  assert.equal(ownerCell.store.getSession(quiet)?.id, quiet, "the busy chat stays")
  assert.equal(ownerCell.cells.progress(quiet)?.state, "busy")
  assert.equal(ownerCell.store.getSession(side), null)
  assert.ok(renamed)
  // Changed while copied: that copy was refused (at commit, or here before forwarding), and the next attempt copied the
  // chat as it is now.
  assert.equal(cells.calls.filter((call) => call.to === sessionCellName(main) && call.path === "/internal/import/begin").length, 2)
  assert.equal(ownerCell.store.getSession(main), null)
  assert.equal(cells.cell(sessionCellName(main)).store.getSession(main)?.title, "Renamed mid-copy")
  // Once the busy chat's turn ends, it moves too.
  ownerCell.store.setTurnStatus(quiet, "running", "completed")
  ownerCell.store.db.prepare("UPDATE split_progress SET next_attempt_at = 0").run()
  await runSplit(ownerCell)
  assert.equal(ownerCell.store.getSession(quiet), null)
  assert.equal(ownerCell.cells.legacySessions(owner).length, 0)
})

test("a chat that changes after its copy is confirmed is not forwarded: the copy is thrown away and made again", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const { main } = seedOwner(ownerCell.store)
  ownerCell.host.startSplit()
  let changed = false
  cells.failWhen((to, path) => {
    if (!changed && to === sessionCellName(main) && path === "/internal/import/commit") {
      changed = true
      // A message arrives while the commit is on its way: the session cell confirms the copy it has.
      finishedTurn(ownerCell.store, main, "msg_late", "Late answer.")
    }
    return false
  })
  await runSplit(ownerCell)
  assert.ok(changed)
  assert.equal(cells.calls.filter((call) => call.to === sessionCellName(main) && call.path === "/internal/import/abort").length, 1)
  assert.equal(ownerCell.store.getSession(main), null)
  assert.equal(cells.cell(sessionCellName(main)).store.getTurn(main, "msg_late")?.status, "completed", "nothing written meanwhile was lost")
})

test("a split killed at any call resumes and moves everything exactly once", async () => {
  // Every point a cell can die: after each call of a full split, the owner cell restarts and runs the split again.
  const reference = world()
  const referenceOwner = reference.cell(ownerCellName(owner))
  seedOwner(referenceOwner.store)
  referenceOwner.host.startSplit()
  await runSplit(referenceOwner)
  const total = reference.calls.length
  reference[Symbol.dispose]()
  assert.ok(total >= 9, `a split makes several calls (${total})`)
  for (let killAt = 1; killAt <= total; killAt += 1) {
    using cells = world()
    const ownerCell = cells.cell(ownerCellName(owner))
    const ids = Object.values(seedOwner(ownerCell.store))
    ownerCell.cells.adoptOwnerMemory(owner)
    const prints = new Map(ids.map((id) => [id, ownerCell.cells.fingerprint(id)]))
    ownerCell.host.startSplit()
    cells.failWhen((_to, _path, count) => count === killAt)
    await runSplit(ownerCell).catch(() => undefined)
    cells.failWhen(null)
    const restarted = cells.restart(ownerCell.name)
    restarted.store.db.prepare("UPDATE split_progress SET next_attempt_at = 0").run()
    await runSplit(restarted, 40)
    for (const id of ids) {
      assert.equal(restarted.store.getSession(id), null, `kill at call ${killAt}: ${id} left the owner cell`)
      assert.equal(cells.cell(sessionCellName(id)).cells.fingerprint(id), prints.get(id), `kill at call ${killAt}: ${id} copied exactly`)
      assert.equal(z.object({ n: z.number() }).parse(cells.cell(sessionCellName(id)).store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).n, 1)
    }
  }
})

test("a session cell takes a copy only from its owner's cell, and never overwrites a chat that lives there", async () => {
  using cells = world()
  const id = "hs_wb_target0000000000"
  const target = cells.cell(sessionCellName(id))
  const fingerprint = "0".repeat(64)
  assert.equal((await target.host.handle(ownerCellName(owner), "/internal/import/begin", { owner, sessionId: "hs_wb_other00000000000", fingerprint })).status, 403)
  assert.equal((await target.host.handle(sessionCellName(id), "/internal/import/begin", { owner, sessionId: id, fingerprint })).status, 403)
  assert.equal((await target.host.handle(ownerCellName(owner), "/internal/import/rows", { owner, sessionId: id, table: "sessions", rows: [] })).status, 409)
  target.store.putSession(id, { title: "Lives here" })
  const refused = await target.host.handle(ownerCellName(owner), "/internal/import/begin", { owner, sessionId: id, fingerprint })
  assert.equal(refused.status, 409)
  assert.equal(target.store.getSession(id)?.title, "Lives here")
  // Owned by someone else: refused.
  const other = cells.cell(sessionCellName("hs_wb_claimed000000000"))
  other.cells.claimCellOwner("wb:someone-else")
  assert.equal((await other.host.handle(ownerCellName(owner), "/internal/import/begin", { owner, sessionId: "hs_wb_claimed000000000", fingerprint })).status, 409)
})

/**
 * A long legacy chat: 45 turns, two with a large tool output (m003, sealed with its output inline in the segment;
 * m040, hot, its output a large body in the bucket), sealed as far as the rules allow.
 */
async function seedSealed(cell: Cell, id: string) {
  const BIG = "A large output line.\n".repeat(400)
  cell.store.putSession(id, { owner, ref: "long", title: "Long chat" })
  const turnIds: string[] = []
  for (let index = 0; index < 45; index += 1) {
    const messageId = `m${String(index).padStart(3, "0")}`
    turnIds.push(messageId)
    if (index === 3 || index === 40) {
      cell.store.admitTurn({ sessionId: id, messageId, prompt: "read the report", model: "test-model" })
      cell.store.startTranscript(id, messageId)
      cell.store.appendMessage(id, messageId, { role: "assistant", text: "", toolCalls: [{ id: "c", name: "read_file", input: { path: "report.md" } }] })
      const prepared = await cell.storage.prepare(id, toolMessage(BIG))
      cell.store.appendMessage(id, messageId, prepared.message, prepared.body)
      cell.store.appendMessage(id, messageId, { role: "assistant", text: "Read it.", toolCalls: [] })
      cell.store.setTurnStatus(id, messageId, "completed")
    } else {
      finishedTurn(cell.store, id, messageId, `${index}: ${"words ".repeat(250)}`)
    }
  }
  assert.ok((await cell.storage.sealAll(id)) > 0, "sealed some turns")
  return { BIG, turnIds }
}

/** Every turn id of a session, paged back from the newest, 7 at a time, through hot and sealed history. */
async function pageBack(storage: SessionStorage, id: string) {
  const ids: string[] = []
  let before: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const window = await storage.readWindow(id, 7, 1_000, before)
    ids.unshift(...window.turns.map((turn) => turn.messageId))
    if (!window.hasEarlier) break
    before = window.turns[0]?.messageId
  }
  return ids
}

test("a sealed chat moves with its segments, large bodies, index reporting and pending deletes, keeping object keys", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const id = "hs_wb_sealed0000000000"
  const { BIG, turnIds } = await seedSealed(ownerCell, id)
  const segmentKeys = cells.bucket.keys(`sessions/${id}/segments/`)
  const bodyKeys = ownerCell.store.db.prepare("SELECT DISTINCT storage_key FROM large_bodies WHERE session_id = ?").all(id).map((row) => z.object({ storage_key: z.string() }).parse(row).storage_key)
  assert.ok(segmentKeys.length > 0, "segments in the bucket")
  assert.ok(bodyKeys.length > 0 && bodyKeys.every((key) => cells.bucket.objects.has(key)), "a hot large body in the bucket")
  // Den already has version N of this chat; version N+1 is still waiting, with its capability.
  ownerCell.store.setIndexCapability(id, "cap-latest")
  ownerCell.store.enqueueIndexUpdate(id)
  const sent = ownerCell.store.pendingIndexUpdates(Date.now() + 1, 10).find((update) => update.sessionId === id)
  assert.ok(sent)
  ownerCell.store.ackIndexUpdate(id, sent.version)
  ownerCell.store.enqueueIndexUpdate(id)
  const waiting = ownerCell.store.pendingIndexUpdates(Date.now() + 1, 10).find((update) => update.sessionId === id)
  assert.ok(waiting && waiting.version > sent.version)
  // A pending delete under the chat's prefix (an object no row references any more), and one of another chat's.
  await cells.bucket.store.put(`sessions/${id}/bodies/stale`, new Uint8Array([1]))
  const queue = ownerCell.store.db.prepare("INSERT INTO storage_deletions (key, kind, due_at, attempt) VALUES (?, 'object', ?, 0)")
  queue.run(`sessions/${id}/bodies/stale`, Date.now() + 3_600_000)
  queue.run("sessions/hs_other_chat_0000/bodies/x", Date.now() + 3_600_000)
  ownerCell.store.db.prepare("INSERT INTO seal_state (session_id, attempt, next_attempt_at, error, updated_at) VALUES (?, 2, 0, 'seal_conflict', 0)").run(id)
  const exported = await ownerCell.storage.exportConversation(id)

  ownerCell.host.startSplit()
  await runSplit(ownerCell)
  const target = cells.cell(sessionCellName(id))
  assert.equal(ownerCell.store.getSession(id), null)
  assert.deepEqual(ownerCell.cells.forwardOf(id), { owner, cell: sessionCellName(id) })
  // Lossless, sealed history and large bodies inline, read from the moved chat's cell with the same object keys.
  assert.deepEqual(await target.storage.exportConversation(id), exported)
  assert.deepEqual(await pageBack(target.storage, id), turnIds)
  for (const messageId of ["m003", "m040"]) {
    const big = await target.storage.readTurn(id, messageId, 100)
    assert.ok(big.messages.some(({ message }) => message.role === "tool" && message.output === BIG), `${messageId}'s large output reads back whole`)
  }
  assert.deepEqual(cells.bucket.keys(`sessions/${id}/segments/`), segmentKeys)
  assert.ok(bodyKeys.every((key) => cells.bucket.objects.has(key)))
  assert.equal(z.object({ attempt: z.number() }).parse(target.store.db.prepare("SELECT attempt FROM seal_state WHERE session_id = ?").get(id)).attempt, 2)
  // The Den index: reported from the session cell under the same id, numbered above what the owner cell sent and
  // queued, with the newest capability; nothing more from the owner cell.
  const next = target.store.pendingIndexUpdates(Date.now() + 1, 10).find((update) => update.sessionId === id)
  assert.ok(next, "the session cell reports the moved chat")
  assert.ok(next.version > waiting.version, `${next.version} > ${waiting.version}`)
  assert.equal(next.capability, "cap-latest")
  assert.equal(ownerCell.store.pendingIndexUpdates(Date.now() + 1, 10).some((update) => update.sessionId === id), false)
  assert.equal(target.cells.meta("index_hold"), null)
  // Pending deletes under the chat's prefix moved with it; the other chat's stayed.
  const keysIn = (cell: Cell) => cell.store.db.prepare("SELECT key FROM storage_deletions ORDER BY key").all().map((row) => z.object({ key: z.string() }).parse(row).key)
  assert.deepEqual(keysIn(ownerCell), ["sessions/hs_other_chat_0000/bodies/x"])
  assert.deepEqual(keysIn(target), [`sessions/${id}/bodies/stale`])
  // The owner cell's cleanup no longer looks at the moved chat's objects; the session cell's deletes only the stale one.
  await ownerCell.storage.scanOrphans()
  assert.deepEqual(cells.bucket.keys(`sessions/${id}/segments/`), segmentKeys)
  target.store.db.prepare("UPDATE storage_deletions SET due_at = 0").run()
  target.storage.deletionsChanged()
  const cleanup = target.storage.jobs().find((job) => job.name === "segment-orphans")
  assert.ok(cleanup && (cleanup.nextAt() ?? Infinity) <= Date.now())
  await cleanup.run()
  assert.equal(cells.bucket.objects.has(`sessions/${id}/bodies/stale`), false)
  assert.ok(bodyKeys.every((key) => cells.bucket.objects.has(key)), "referenced bodies stay")
})

test("storage bookkeeping changing during a move (hot bytes, index version and outbox, seal retries) doesn't restart it", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const id = "hs_wb_busybooks000000"
  await seedSealed(ownerCell, id)
  ownerCell.store.setIndexCapability(id, "cap-1")
  ownerCell.host.startSplit()
  let changed = false
  let ownerVersion = 0
  cells.failWhen((to, path) => {
    if (!changed && to === sessionCellName(id) && path === "/internal/import/commit") {
      changed = true
      // What the sealer, the hot-byte recount and the index outbox do in the background, between copy and forward.
      ownerCell.store.countHotBytes(id)
      ownerCell.store.db.prepare("UPDATE sessions SET hot_bytes = hot_bytes + 7 WHERE id = ?").run(id)
      ownerCell.store.enqueueIndexUpdate(id)
      ownerCell.store.enqueueIndexUpdate(id)
      ownerCell.store.setIndexCapability(id, "cap-2")
      ownerCell.store.db.prepare("INSERT OR REPLACE INTO seal_state (session_id, attempt, next_attempt_at, error, updated_at) VALUES (?, 1, 0, 'x', 0)").run(id)
      ownerVersion = ownerCell.cells.handoffOf(id).indexVersion
    }
    return false
  })
  const before = cells.calls.length
  await runSplit(ownerCell)
  assert.ok(changed)
  const calls = cells.calls.slice(before)
  assert.equal(calls.filter((call) => call.path === "/internal/import/begin").length, 1, "copied once")
  assert.equal(calls.filter((call) => call.path === "/internal/import/abort").length, 0)
  assert.equal(ownerCell.store.getSession(id), null)
  const target = cells.cell(sessionCellName(id))
  const next = target.store.pendingIndexUpdates(Date.now() + 1, 10).find((update) => update.sessionId === id)
  assert.ok(next)
  assert.equal(next.capability, "cap-2", "the newest capability went with the handoff")
  assert.ok(next.version > ownerVersion)
})

test("a session cell holds its Den index updates until the owner cell hands over, and the handoff survives a crash", async () => {
  using cells = world()
  const ownerCell = cells.cell(ownerCellName(owner))
  const id = "hs_wb_handoff00000000"
  ownerCell.store.putSession(id, { owner, ref: "x" })
  finishedTurn(ownerCell.store, id, "m1", "one")
  ownerCell.store.setIndexCapability(id, "cap")
  for (let round = 0; round < 5; round += 1) ownerCell.store.enqueueIndexUpdate(id)
  const ownerVersion = ownerCell.cells.handoffOf(id).indexVersion
  ownerCell.host.startSplit()
  // The handoff call fails (the session cell's node died): the chat is forwarded, its index held there.
  cells.failWhen((to, path) => path === "/internal/import/handoff")
  await runSplit(ownerCell, 1)
  cells.failWhen(null)
  const target = cells.cell(sessionCellName(id))
  assert.equal(ownerCell.store.getSession(id), null)
  assert.notEqual(ownerCell.cells.pendingHandoff(), null)
  assert.equal(target.cells.meta("index_hold"), "1")
  // A forwarded request changes the chat meanwhile: queued there, but not sent while held.
  finishedTurn(target.store, id, "m2", "two")
  assert.ok(target.store.pendingIndexUpdates(Date.now() + 1, 10).length > 0)
  assert.equal(ownerCell.host.startSplit(), "running", "not done while a handoff waits")
  // The owner cell restarts; its split hands over, and the session cell's next update is above the owner's.
  const restarted = cells.restart(ownerCell.name)
  restarted.store.db.prepare("UPDATE split_handoff SET next_attempt_at = 0").run()
  await runSplit(restarted)
  assert.equal(restarted.cells.pendingHandoff(), null)
  assert.equal(target.cells.meta("index_hold"), null)
  const next = target.store.pendingIndexUpdates(Date.now() + 1, 10).find((update) => update.sessionId === id)
  assert.ok(next && next.version > ownerVersion, `${next?.version} > ${ownerVersion}`)
  assert.equal(restarted.host.startSplit(), "done")
})
