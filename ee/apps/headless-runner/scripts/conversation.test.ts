import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { createApp, DEFAULT_READ_TURNS, MAX_READ_TURNS } from "../src/app.js"
import { SessionEvents } from "../src/events.js"
import type { McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"
import type { Message } from "../src/types.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })

/** The prompt the newest user message in a request was sent with (the runner prefixes each with when it was sent). */
const promptOf = (request: ModelRequest) => {
  const last = request.messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user").at(-1)
  return last?.text.split("\n").at(-1) ?? ""
}

function setup(model: ModelClient, mcp?: McpConnector) {
  const directory = mkdtempSync(join(tmpdir(), "headless-interrupt-"))
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, events: new SessionEvents(), mcp })
  const session = store.createSession({ owner: "test" })
  return { store, runner, session: session.id, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

test("a follow-up stops an answer while it writes, keeps what it wrote, and is answered with it in view", async () => {
  const requests: ModelRequest[] = []
  const words = ["Here", " is", " your", " whole", " week,", " day", " by", " day."]
  // The follow-up is sent once part of the answer is written, however long the runner took to start the model call.
  let partlyWritten: () => void = () => undefined
  const written = new Promise<void>((resolve) => {
    partlyWritten = resolve
  })
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      if (promptOf(request) !== "Summarize my week") return { text: "Got it, just today.", toolCalls: [], usage }
      for (const [index, word] of words.entries()) {
        await sleep(40, request.signal)
        request.onText?.(word)
        if (index === 2) partlyWritten()
      }
      return { text: words.join(""), toolCalls: [], usage }
    },
  }
  using world = setup(model)
  world.runner.send({ sessionId: world.session, messageId: "first", prompt: "Summarize my week", credentials: {} })
  await written
  world.runner.send({ sessionId: world.session, messageId: "second", prompt: "Actually, just today.", credentials: {}, interrupt: true })
  await world.runner.idle()

  const first = world.store.getTurn(world.session, "first")
  assert.equal(first?.status, "aborted")
  assert.equal(first?.error, "superseded")
  const kept = world.store.turnMessages(world.session, "first").flatMap(({ message }) => (message.role === "assistant" ? [message.text] : []))
  assert.equal(kept.length, 1)
  assert.ok(kept[0] && kept[0].length > 0 && kept[0].length < words.join("").length && words.join("").startsWith(kept[0]), `kept the words written so far: ${JSON.stringify(kept)}`)
  assert.equal(world.store.getTurn(world.session, "second")?.status, "completed")
  const answer = requests.at(-1)
  assert.ok(answer?.messages.some((message) => message.role === "assistant" && message.text === kept[0]), "the follow-up's answer sees what was already said")
})

test("a follow-up during an app step lets the step finish, then wraps up before the next model call", async () => {
  let lookupStarted: () => void = () => undefined
  const lookingUp = new Promise<void>((resolve) => {
    lookupStarted = resolve
  })
  let lookups = 0
  let firstCalls = 0
  const model: ModelClient = {
    async complete(request) {
      if (promptOf(request) === "Check my calendar") {
        firstCalls += 1
        return firstCalls === 1 ? { text: "Let me look.", toolCalls: [{ id: "call_1", name: "slow_lookup", input: {} }], usage } : { text: "Here it is.", toolCalls: [], usage }
      }
      return { text: "Sure, just today then.", toolCalls: [], usage }
    },
  }
  const mcp: McpConnector = async () => ({
    tools: [{ name: "slow_lookup", description: "A lookup that takes a moment", inputSchema: { type: "object" } }],
    async call(_name, _input, signal) {
      lookupStarted()
      await sleep(150, signal)
      lookups += 1
      return { output: "3:30 design review", isError: false }
    },
    async close() {},
  })
  using world = setup(model, mcp)
  world.runner.send({ sessionId: world.session, messageId: "first", prompt: "Check my calendar", credentials: { mcpToken: "token" } })
  // The follow-up arrives while the lookup runs, however long the runner took to get there.
  await lookingUp
  world.runner.send({ sessionId: world.session, messageId: "second", prompt: "Actually, just today.", credentials: { mcpToken: "token" }, interrupt: true })
  await world.runner.idle()

  assert.equal(lookups, 1, "the running lookup was not cut off")
  assert.equal(firstCalls, 1, "no model call after the follow-up arrived")
  const result = world.store.turnMessages(world.session, "first").find(({ message }) => message.role === "tool")?.message
  assert.ok(result?.role === "tool" && result.output === "3:30 design review" && !result.isError)
  assert.equal(world.store.getTurn(world.session, "first")?.error, "superseded")
  assert.equal(world.store.getTurn(world.session, "second")?.status, "completed")
})

test("messages already waiting are answered together with the follow-up that interrupts", async () => {
  let firstStarted: () => void = () => undefined
  const answeringFirst = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  const requests: ModelRequest[] = []
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      if (promptOf(request) === "First") {
        firstStarted()
        await sleep(200, request.signal)
        return { text: "First answer.", toolCalls: [], usage }
      }
      return { text: `Answering ${promptOf(request)}`, toolCalls: [], usage }
    },
  }
  using world = setup(model)
  world.runner.send({ sessionId: world.session, messageId: "a", prompt: "First", credentials: {} })
  // The others arrive while the first answer is being written, however long the runner took to start it.
  await answeringFirst
  world.runner.send({ sessionId: world.session, messageId: "b", prompt: "Second", credentials: {} })
  world.runner.send({ sessionId: world.session, messageId: "c", prompt: "Third", credentials: {}, interrupt: true })
  await world.runner.idle()

  assert.equal(world.store.getTurn(world.session, "a")?.error, "superseded")
  assert.equal(world.store.getTurn(world.session, "b")?.error, "superseded")
  assert.equal(world.store.getTurn(world.session, "c")?.status, "completed")
  assert.deepEqual(requests.map(promptOf), ["First", "Third"], "no model call is spent on the message answered together")
  const answer = requests.at(-1)
  assert.ok(answer?.messages.some((message) => message.role === "user" && message.text.endsWith("Second")), "the answer sees the waiting message too")
})

test("a read-only turn's lookups run at the same time", async () => {
  let running = 0
  let most = 0
  let calls = 0
  const model: ModelClient = {
    async complete() {
      calls += 1
      return calls === 1
        ? { text: "Let me look at your day.", toolCalls: [{ id: "calendar", name: "slow_lookup", input: { app: "calendar" } }, { id: "mail", name: "slow_lookup", input: { app: "mail" } }], usage }
        : { text: "A design review at 3:30, and two emails need you.", toolCalls: [], usage }
    },
  }
  const mcp: McpConnector = async () => ({
    tools: [{ name: "slow_lookup", description: "A lookup that takes a moment", inputSchema: { type: "object" } }],
    async call(_name, input, signal) {
      running += 1
      most = Math.max(most, running)
      await sleep(120, signal)
      running -= 1
      return { output: `found in ${String(input.app)}`, isError: false }
    },
    async close() {},
  })
  using world = setup(model, mcp)
  world.runner.send({ sessionId: world.session, messageId: "hello", prompt: "Look at my day", credentials: { mcpToken: "token", readOnly: true } })
  await world.runner.idle()

  assert.equal(most, 2, "both lookups ran together")
  assert.equal(world.store.getTurn(world.session, "hello")?.status, "completed")
  const results = world.store.turnMessages(world.session, "hello").flatMap(({ message }) => (message.role === "tool" ? [message.callId] : []))
  assert.deepEqual(results, ["calendar", "mail"], "results are stored in the order the calls were made")
})

test("a message waiting its turn comes back with its text until it starts", () => {
  using world = setup({ async complete() { return { text: "", toolCalls: [], usage } } })
  world.store.admitTurn({ sessionId: world.session, messageId: "waiting", prompt: "Actually, just today.", model: null })
  assert.equal(world.store.waitingPrompts(world.session, ["waiting"]).get("waiting"), "Actually, just today.")
  world.store.startTranscript(world.session, "waiting")
  assert.equal(world.store.waitingPrompts(world.session, ["waiting"]).size, 0, "once it starts, its transcript has the text")
})

const apiToken = "test-token-".padEnd(40, "x")
const readSchema = z.object({
  status: z.string(),
  turns: z.array(z.object({ messageId: z.string(), status: z.string(), kind: z.string().optional() })),
  messages: z.array(z.object({ messageId: z.string(), role: z.string() })),
  finalAssistantText: z.string(),
  hasEarlier: z.boolean().optional(),
})

/** GET /v1/sessions/:id through the app, as a caller reads it. */
async function readSession(app: ReturnType<typeof createApp>, sessionId: string, query: Record<string, string> = {}) {
  const response = await app.request(`/v1/sessions/${sessionId}?${new URLSearchParams(query).toString()}`, { headers: { authorization: `Bearer ${apiToken}` } })
  assert.equal(response.status, 200)
  return readSchema.parse(await response.json())
}

/** A finished turn: the person's message and the answer, written in `answers` messages. */
function seedTurn(store: Store, sessionId: string, messageId: string, input: { answers?: string[]; kind?: "task" | "report"; parent?: string } = {}) {
  store.admitTurn({ sessionId, messageId, prompt: `prompt ${messageId}`, model: null, kind: input.kind, parent: input.parent })
  store.startTranscript(sessionId, messageId)
  for (const text of input.answers ?? [`answer ${messageId}`]) store.appendMessage(sessionId, messageId, { role: "assistant", text, toolCalls: [] })
  store.setTurnStatus(sessionId, messageId, "completed")
}

test("a session read is always windowed: a default window, a clamped one, and paging back once through every turn", async () => {
  using world = setup({ async complete() { return { text: "", toolCalls: [], usage } } })
  const app = createApp({ store: world.store, runner: world.runner, apiToken })
  const ids = Array.from({ length: 250 }, (_, index) => `m${index}`)
  for (const id of ids.slice(0, -1)) seedTurn(world.store, world.session, id)
  seedTurn(world.store, world.session, "m249", { answers: ["one", "two", "three", "four"] })

  const recent = await readSession(app, world.session)
  assert.equal(recent.turns.length, DEFAULT_READ_TURNS, "without turns, the newest window")
  assert.deepEqual(recent.turns.map((turn) => turn.messageId), ids.slice(-DEFAULT_READ_TURNS))
  assert.equal(recent.hasEarlier, true)
  assert.equal(recent.finalAssistantText, "one\n\ntwo\n\nthree\n\nfour", "the newest turn's answer")
  assert.ok(recent.messages.every((message) => recent.turns.some((turn) => turn.messageId === message.messageId)), "only the window's messages")
  assert.equal(recent.status, "idle")

  const clamped = await readSession(app, world.session, { turns: "100000" })
  assert.equal(clamped.turns.length, MAX_READ_TURNS, "asking for more than the most gets the most")
  assert.equal(clamped.hasEarlier, true)

  // A cut by `limit` keeps the newest messages and still answers with the whole newest turn.
  const cut = await readSession(app, world.session, { turns: "5", limit: "2" })
  assert.deepEqual(cut.messages.map((message) => message.messageId), ["m249", "m249"])
  assert.equal(cut.finalAssistantText, "one\n\ntwo\n\nthree\n\nfour")

  const seen: string[] = []
  let before: string | undefined
  for (let page = 0; page < 20; page++) {
    const read = await readSession(app, world.session, { turns: "70", ...(before ? { before } : {}) })
    seen.unshift(...read.turns.map((turn) => turn.messageId))
    if (!read.hasEarlier) break
    before = read.turns[0]?.messageId
  }
  assert.deepEqual(seen, ids, "every turn exactly once, in order, back to the first")

  // A turn outside the window still makes the conversation busy.
  world.store.setTurnStatus(world.session, "m0", "running")
  assert.equal((await readSession(app, world.session, { turns: "1" })).status, "busy")
})

test("reading one turn returns its transcript, its tasks and their reports, and nothing else", async () => {
  using world = setup({ async complete() { return { text: "", toolCalls: [], usage } } })
  const app = createApp({ store: world.store, runner: world.runner, apiToken })
  seedTurn(world.store, world.session, "a")
  seedTurn(world.store, world.session, "b", { answers: ["Looking.", "Started it."] })
  seedTurn(world.store, world.session, "a.t1", { kind: "task", parent: "a" })
  seedTurn(world.store, world.session, "b.t1", { kind: "task", parent: "b" })
  seedTurn(world.store, world.session, "c")
  seedTurn(world.store, world.session, "b.t1.r", { kind: "report", parent: "b.t1" })

  const read = await readSession(app, world.session, { messageId: "b", outputs: "none" })
  assert.deepEqual(read.turns.map((turn) => turn.messageId), ["b", "b.t1", "b.t1.r"])
  assert.deepEqual([...new Set(read.messages.map((message) => message.messageId))], ["b"])
  assert.equal(read.finalAssistantText, "Looking.\n\nStarted it.")
  assert.equal(read.hasEarlier, undefined, "a turn read is not a window")

  const last = await readSession(app, world.session, { messageId: "b", limit: "1" })
  assert.deepEqual(last.messages.map((message) => message.role), ["assistant"], "limit keeps the turn's newest messages")
  assert.equal(last.finalAssistantText, "Looking.\n\nStarted it.", "the answer is still the whole turn's")

  const unknown = await readSession(app, world.session, { messageId: "missing" })
  assert.deepEqual(unknown.turns, [])
  assert.deepEqual(unknown.messages, [])
})

test("opening a document is a request the runner records only for a navigation-enabled person's message, including read-only ones", async () => {
  for (const execution of [undefined, "steps" as const]) for (const enabled of [false, true]) {
    let calls = 0
    const requests: ModelRequest[] = []
    using world = setup({ async complete(request) {
      requests.push(request)
      return ++calls === 1
        ? { text: "Opening it beside our chat.", toolCalls: [{ id: "open1", name: "open_document", input: { fileId: "file_example" } }], usage }
        : { text: "It should appear beside our chat.", toolCalls: [], usage }
    } })
    const app = createApp({ store: world.store, runner: world.runner, apiToken })
    const saved = await app.request(`/v1/sessions/${world.session}`, { method: "PUT", headers: { authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ documentNavigation: enabled }) })
    assert.equal(saved.status, 200)
    assert.equal(world.store.getSession(world.session)?.documentNavigation, enabled)
    world.runner.send({ sessionId: world.session, messageId: "open", prompt: "Open the current document for me", credentials: { readOnly: true }, execution })
    await world.runner.idle()
    assert.equal(requests[0]?.tools.some(tool => tool.name === "open_document"), enabled)
    const result = world.store.turnMessages(world.session, "open").find(({ message }) => message.role === "tool" && message.name === "open_document")?.message
    assert.ok(result?.role === "tool")
    assert.equal(result.isError, !enabled)
    // Only a request: whether the document opened is for the person's page to say.
    if (enabled) assert.deepEqual(JSON.parse(result.output), { fileId: "file_example", status: "requested" })
  }
})
