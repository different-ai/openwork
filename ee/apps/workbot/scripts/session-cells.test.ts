/**
 * Per-chat session cells in Workbot: new chats get `hs_c_<32 hex>` ids with owner-scoped memory and the
 * person's existing chats are split out once per process with current Den. Older Den's missing/false sessionCells
 * field preserves legacy creation. Chats are found from the runner's list regardless, preferring a session cell, so
 * reconnecting to an older Den never makes a chat look empty or get replaced. A list that can't be read never leads to a new chat replacing an existing one.
 * Den's session index: the index capability Den returns with a run token reaches the runner with the turn.
 */
import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createWorkbot, resetWorkbotSessionCells, workbotOwner, workbotSessionId, workbotSideChatSessionId, WorkbotUnavailableError, type WorkbotActor } from "@openwork-ee/workbot-server"
import { denSessionSchema } from "../src/server/den.js"

const CELL_ID = /^hs_c_[a-f0-9]{32}$/
const actor: WorkbotActor = { organizationId: "org_cells", organizationName: "Example", organizationMetadata: null, memberId: "member_cells", userId: "user_cells", firstName: "Alex" }
const owner = workbotOwner(actor.organizationId, actor.memberId)
const legacyMain = workbotSessionId(actor.organizationId, actor.memberId)
const SIDE = "sidechat00000001"

type Call = { method: string; path: string; body: Record<string, unknown> | null; owner: string | null }
type StoredSession = { ref: string | null; turns: Array<{ messageId: string; prompt: string }>; files: number; body: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A runner that keeps sessions like the real one: PUT creates or updates, turns are stored and read back, and the
 * owner's list names only chats with a message (`unlisted` hides some, like a session cell's directory entry not yet
 * updated). `listStatus` makes the list fail.
 */
function fakeRunner(options: { split?: number } = {}) {
  const calls: Call[] = []
  const sessions = new Map<string, StoredSession>()
  const state = { listStatus: 200, unlisted: new Set<string>() }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? "GET"
    const raw: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null
    const body = isRecord(raw) ? raw : null
    calls.push({ method, path: url.pathname, body, owner: new Headers(init?.headers).get("x-openwork-headless-owner") })
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
    const [, , segment, id, rest] = url.pathname.split("/")
    if (url.pathname === "/v1/owner/split") return options.split === 404 ? json(404, { error: "not_found" }) : json(202, { split: "started" })
    if (url.pathname === "/v1/files/status") return json(200, { enabled: false })
    if (method === "GET" && url.pathname === "/v1/sessions") {
      if (state.listStatus !== 200) return json(state.listStatus, { error: "unavailable" })
      const listed = [...sessions.entries()].filter(([sessionId, session]) => session.turns.length > 0 && !state.unlisted.has(sessionId))
      return json(200, { sessions: listed.map(([sessionId, session]) => ({ id: sessionId, ref: session.ref, title: "Chat", createdAt: 1, updatedAt: 2 })) })
    }
    if (segment !== "sessions" || !id) return json(404, { error: "not_found" })
    const sessionId = decodeURIComponent(id)
    const session = sessions.get(sessionId)
    if (method === "PUT") {
      const ref = typeof body?.ref === "string" ? body.ref : null
      if (session) {
        session.body = body ?? {}
        return json(200, { id: sessionId })
      }
      sessions.set(sessionId, { ref, turns: [], files: 0, body: body ?? {} })
      return json(201, { id: sessionId })
    }
    if (!session) return json(404, { error: "unknown_session" })
    if (method === "POST" && rest === "turns") {
      const messageId = typeof body?.messageId === "string" ? body.messageId : ""
      if (!session.turns.some((turn) => turn.messageId === messageId)) session.turns.push({ messageId, prompt: typeof body?.prompt === "string" ? body.prompt : "" })
      return json(202, { state: "accepted" })
    }
    if (method === "GET" && rest === undefined) {
      return json(200, {
        turns: session.turns.map((turn) => ({ messageId: turn.messageId, status: "completed", error: null, createdAt: 1 })),
        messages: session.turns.flatMap((turn) => [
          { role: "user", messageId: turn.messageId, text: turn.prompt },
          { role: "assistant", messageId: turn.messageId, text: `Answer to ${turn.prompt}`, toolCalls: [] },
        ]),
        finalAssistantText: "",
      })
    }
    return json(404, { error: "not_found" })
  }
  return { calls, fetch, sessions, state }
}

function workbotWith(runner: ReturnType<typeof fakeRunner>, compat: { sessionCells?: boolean; indexCapability?: string } = {}) {
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner.test", token: "x".repeat(32), owner },
    fetch: runner.fetch,
    mintToken: async () => ({ token: "turn-token", ...(compat.indexCapability ? { indexCapability: compat.indexCapability } : {}) }),
    maxTokenTtlMs: 3_600_000,
  })
  return createWorkbot({ client, canSchedule: async () => false, ...(compat.sessionCells ? { sessionCells: true } : {}) })
}

const puts = (calls: Call[]) => calls.filter((call) => call.method === "PUT")
const turns = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.path.endsWith("/turns"))
const splits = (calls: Call[]) => calls.filter((call) => call.path === "/v1/owner/split")
const lists = (calls: Call[]) => calls.filter((call) => call.method === "GET" && call.path === "/v1/sessions")
const tick = () => new Promise((resolve) => setImmediate(resolve))
/** A new Workbot process: nothing remembered. */
const restart = () => resetWorkbotSessionCells()
const texts = (thread: Awaited<ReturnType<ReturnType<typeof workbotWith>["readThread"]>>) => JSON.stringify(thread.turns)

beforeEach(() => resetWorkbotSessionCells())

test("Den protocol compatibility: missing sessionCells from an older Den defaults false", () => {
  const base = { user: { id: "u", name: null, email: "a@example.test" }, organization: { id: "o", name: "O", brandAppName: null }, memberId: "m", enabled: true, canSchedule: false }
  assert.equal(denSessionSchema.parse(base).sessionCells, false)
  assert.equal(denSessionSchema.parse({ ...base, sessionCells: true }).sessionCells, true)
})

test("older Den, new person: chats are created exactly as before (legacy ids, memoryOf, no split, no index capability)", async () => {
  const runner = fakeRunner()
  const workbot = workbotWith(runner)
  await workbot.readThread(actor)
  await workbot.send(actor, { id: "message_0001", text: "Hello" })
  await workbot.send(actor, { id: "message_0002", text: "Side", chat: SIDE })
  await tick()
  assert.equal(splits(runner.calls).length, 0, "never asks the runner to split")
  const side = workbotSideChatSessionId(actor.organizationId, actor.memberId, SIDE)
  assert.deepEqual([...runner.sessions.keys()].sort(), [legacyMain, side].sort())
  for (const call of puts(runner.calls)) assert.equal(call.body?.memoryScope, undefined)
  assert.equal(runner.sessions.get(side)?.body.memoryOf, legacyMain)
  for (const call of turns(runner.calls)) {
    assert.ok(isRecord(call.body?.credentials))
    assert.equal(call.body.credentials.indexCapability, undefined, "no index capability without one from Den")
  }
  assert.equal(lists(runner.calls).length, 1, "one list call per person per process")
})

test("current Den, new person: new chats get hs_c_ ids with owner memory, and the split is asked once per process", async () => {
  const runner = fakeRunner()
  const workbot = workbotWith(runner, { sessionCells: true })
  await workbot.readThread(actor)
  await workbot.readThread(actor)
  await workbot.send(actor, { id: "message_0001", text: "Hello" })
  await workbot.send(actor, { id: "message_0002", text: "Side", chat: SIDE })
  await tick()
  assert.equal(splits(runner.calls).length, 1, "split asked exactly once")
  assert.equal(splits(runner.calls)[0]?.owner, owner, "owner-scoped")
  const ids = [...runner.sessions.keys()]
  assert.equal(ids.length, 2)
  for (const id of ids) assert.match(id, CELL_ID)
  for (const session of runner.sessions.values()) {
    assert.equal(session.body.memoryScope, "owner")
    assert.equal(session.body.memoryOf, undefined, "memoryScope replaces memoryOf")
  }
  assert.match(await workbot.sessionIdOf(actor), CELL_ID)
  assert.equal(lists(runner.calls).length, 1, "one list call per person per process")
})

test("older Den after current Den: the same main chat and side chats still open with their history, and nothing new is created", async () => {
  const runner = fakeRunner()
  const on = workbotWith(runner, { sessionCells: true })
  await on.send(actor, { id: "message_0001", text: "Main history" })
  await on.send(actor, { id: "message_0002", text: "Side history", chat: SIDE })
  const cellMain = await on.sessionIdOf(actor)
  const cellSide = await on.sessionIdOf(actor, SIDE)
  assert.match(cellMain, CELL_ID)
  assert.match(cellSide, CELL_ID)

  for (const sameProcess of [true, false]) {
    if (!sameProcess) restart()
    const off = workbotWith(runner)
    const before = runner.sessions.size
    assert.equal(await off.sessionIdOf(actor), cellMain)
    assert.equal(await off.sessionIdOf(actor, SIDE), cellSide)
    assert.ok(texts(await off.readThread(actor)).includes("Main history"), "the main chat opens with its history")
    assert.ok(texts(await off.readThread(actor, { chat: SIDE })).includes("Side history"), "the side chat opens with its history")
    assert.deepEqual(await off.hello(actor, {}), { started: false }, "no greeting: the main chat exists")
    await off.send(actor, { id: `message_more_${sameProcess}`, text: "Still here" })
    assert.equal(runner.sessions.size, before, "no new chat replaced an existing one")
    assert.equal(runner.sessions.get(cellMain)?.turns.at(-1)?.messageId, `wb_message_more_${sameProcess}`, "new messages go to the same chat")
  }
  assert.equal(runner.sessions.has(legacyMain), false, "never a legacy main chat")
})

test("older Den, main chat in a cell but not listed yet: starting it finds the cell instead of creating a legacy chat", async () => {
  const runner = fakeRunner()
  await workbotWith(runner, { sessionCells: true }).send(actor, { id: "message_0001", text: "Main history" })
  const [cellMain] = runner.sessions.keys()
  assert.ok(cellMain)
  runner.state.unlisted.add(cellMain)
  restart()
  const off = workbotWith(runner)
  await off.hello(actor, {})
  await off.send(actor, { id: "message_0002", text: "More" })
  assert.equal(runner.sessions.has(legacyMain), false, "no legacy main chat created")
  assert.equal(runner.sessions.get(cellMain)?.turns.length, 2)
})

test("current Den, a legacy chat that never had a message (e.g. only a kept file) is kept, not replaced by a new cell chat", async () => {
  const runner = fakeRunner()
  runner.sessions.set(legacyMain, { ref: "main", turns: [], files: 1, body: {} })
  const side = workbotSideChatSessionId(actor.organizationId, actor.memberId, SIDE)
  runner.sessions.set(side, { ref: SIDE, turns: [], files: 1, body: {} })
  const workbot = workbotWith(runner, { sessionCells: true })
  await workbot.send(actor, { id: "message_0001", text: "Hello" })
  await workbot.send(actor, { id: "message_0002", text: "Side", chat: SIDE })
  assert.deepEqual([...runner.sessions.keys()].sort(), [legacyMain, side].sort(), "no cell chat created")
  assert.equal(runner.sessions.get(side)?.body.memoryOf, legacyMain, "the legacy side chat keeps sharing the main chat's memory")
})

test("current Den, existing person: listed chats keep their ids; a chat in a cell wins over its legacy id; a new side chat gets a cell", async () => {
  const runner = fakeRunner({ split: 404 })
  const legacySide = workbotSideChatSessionId(actor.organizationId, actor.memberId, SIDE)
  const movedSide = "hs_c_0123456789abcdef0123456789abcdef"
  runner.sessions.set(legacyMain, { ref: "main", turns: [{ messageId: "wb_old", prompt: "Old" }], files: 0, body: {} })
  runner.sessions.set(legacySide, { ref: SIDE, turns: [{ messageId: "wb_old", prompt: "Old side" }], files: 0, body: {} })
  runner.sessions.set(movedSide, { ref: SIDE, turns: [{ messageId: "wb_old", prompt: "Old side" }], files: 0, body: {} })
  const workbot = workbotWith(runner, { sessionCells: true })
  await workbot.readThread(actor)
  await workbot.send(actor, { id: "message_0001", text: "Hello" })
  await workbot.send(actor, { id: "message_0003", text: "New", chat: "sidechat00000002" })
  await tick()
  assert.equal(splits(runner.calls).length, 1, "an older runner's 404 is ignored")
  assert.equal(await workbot.sessionIdOf(actor), legacyMain)
  assert.equal(await workbot.sessionIdOf(actor, SIDE), movedSide, "the cell copy is preferred")
  assert.equal(runner.sessions.get(legacyMain)?.body.memoryScope, undefined, "the legacy main chat is kept as it was")
  const created = [...runner.sessions.keys()].filter((id) => CELL_ID.test(id) && id !== movedSide)
  assert.equal(created.length, 1)
  assert.equal(runner.sessions.get(created[0] ?? "")?.body.memoryScope, "owner")
})

test("the list can't be read: chats work as before session cells, an existing chat is never replaced, and the list is read again later", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 })
  const runner = fakeRunner()
  const on = workbotWith(runner, { sessionCells: true })
  await on.send(actor, { id: "message_0001", text: "Main history" })
  await on.send(actor, { id: "message_0002", text: "Side history", chat: SIDE })
  const cellMain = await on.sessionIdOf(actor)
  const cellSide = await on.sessionIdOf(actor, SIDE)
  restart()
  runner.state.listStatus = 503
  const off = workbotWith(runner)
  const before = runner.sessions.size
  assert.deepEqual(await off.hello(actor, {}), { started: false }, "the main chat is found, not started again")
  await off.send(actor, { id: "message_0003", text: "During the outage" })
  await off.send(actor, { id: "message_0004", text: "Side during the outage", chat: SIDE })
  assert.equal(runner.sessions.size, before, "no new chat replaced an existing one")
  assert.equal(runner.sessions.get(cellMain)?.turns.at(-1)?.messageId, "wb_message_0003")
  assert.equal(runner.sessions.get(cellSide)?.turns.at(-1)?.messageId, "wb_message_0004")
  assert.ok(texts(await off.readThread(actor)).includes("Main history"), "the main chat opens with its history")
  assert.equal(lists(runner.calls).length, 2, "a failed list is not read again on every request")

  // A brand-new person while the list can't be read: chats are created exactly as before (legacy ids).
  const newcomer: WorkbotActor = { ...actor, memberId: "member_new" }
  await off.send(newcomer, { id: "message_0005", text: "Hello" })
  assert.ok(runner.sessions.has(workbotSessionId(actor.organizationId, "member_new")))

  // The checks before creating can't be made either: refuse rather than guess.
  restart()
  const failing = workbotWith({ ...runner, fetch: async (input, init) => (init?.method ?? "GET") === "GET" ? new Response("{}", { status: 503 }) : runner.fetch(input, init) })
  await assert.rejects(failing.send({ ...actor, memberId: "member_other" }, { id: "message_0006", text: "Hello" }), WorkbotUnavailableError)

  runner.state.listStatus = 200
  t.mock.timers.setTime(1_000_000 + 31_000)
  await off.listChats(actor)
  assert.equal(await off.sessionIdOf(actor, SIDE), cellSide)
})

test("an index capability from Den goes to the runner in the turn's credentials", async () => {
  const runner = fakeRunner()
  const workbot = workbotWith(runner, { indexCapability: "hic1.payload.mac" })
  await workbot.send(actor, { id: "message_0001", text: "Hello" })
  const [turn] = turns(runner.calls)
  assert.ok(isRecord(turn?.body?.credentials))
  assert.equal(turn.body.credentials.indexCapability, "hic1.payload.mac")
  assert.equal(turn.body.credentials.mcpToken, "turn-token")
})
