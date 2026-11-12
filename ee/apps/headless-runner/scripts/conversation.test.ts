import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { createApp, DEFAULT_READ_TURNS, MAX_READ_TURNS } from "../src/app.js"
import { SessionEvents } from "../src/events.js"
import { remoteMcpConnector, type McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { buildContext, MCP_CONNECT_RETRY_MS, Runner, TRIMMED_TOOL_ATTACHMENTS, TURN_IMAGES, type RunnerOptions } from "../src/runner.js"
import { Store, type StoredMessage } from "../src/store.js"
import type { Message, SessionComputer, ToolMessage } from "../src/types.js"

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

function setup(model: ModelClient, mcp?: McpConnector, options: Partial<RunnerOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "headless-interrupt-"))
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, events: new SessionEvents(), mcp, ...options })
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

test("a step whose calls all only read runs them at the same time in any turn; one with a call that may change something runs in order", async () => {
  for (const execution of [undefined, "steps" as const]) {
    let running = 0
    let calls = 0
    // The most calls running together in each step, and what started and ended when.
    const most = new Map<number, number>()
    const log: string[] = []
    const model: ModelClient = {
      async complete() {
        calls += 1
        if (calls === 1) return { text: "Let me look at your day.", toolCalls: [{ id: "calendar", name: "lookup", input: { app: "calendar" } }, { id: "notes", name: "read_file", input: { path: "notes.md" } }, { id: "mail", name: "lookup", input: { app: "mail" } }], usage }
        if (calls === 2) return { text: "Checking your tasks, then noting it.", toolCalls: [{ id: "tasks", name: "lookup", input: { app: "tasks" } }, { id: "note", name: "add_note", input: { app: "notes" } }], usage }
        return { text: "A design review at 3:30; I noted it.", toolCalls: [], usage }
      },
    }
    const mcp: McpConnector = async () => ({
      tools: [
        { name: "lookup", description: "Looks something up", inputSchema: { type: "object" }, readOnly: true },
        { name: "add_note", description: "Adds a note", inputSchema: { type: "object" } },
      ],
      async call(name, input, signal) {
        running += 1
        most.set(calls, Math.max(most.get(calls) ?? 0, running))
        log.push(`${name} ${String(input.app)} started`)
        await sleep(80, signal)
        log.push(`${name} ${String(input.app)} ended`)
        running -= 1
        return { output: `done in ${String(input.app)}`, isError: false }
      },
      async close() {},
    })
    using world = setup(model, mcp)
    // Not a read-only turn: it may change things, so only steps that just read run their calls together.
    world.runner.send({ sessionId: world.session, messageId: "day", prompt: "Look at my day", credentials: { mcpToken: "token" }, execution })
    await world.runner.idle()

    const mode = execution ?? "one go"
    assert.equal(world.store.getTurn(world.session, "day")?.status, "completed", mode)
    assert.equal(most.get(1), 2, `${mode}: the lookups ran together, the local read beside them`)
    assert.equal(most.get(2), 1, `${mode}: a step with a call that may change something runs one call at a time`)
    assert.deepEqual(log.slice(-4), ["lookup tasks started", "lookup tasks ended", "add_note notes started", "add_note notes ended"], `${mode}: in the order the model asked`)
    const results = world.store.turnMessages(world.session, "day").flatMap(({ message }) => (message.role === "tool" ? [message.callId] : []))
    assert.deepEqual(results, ["calendar", "notes", "mail", "tasks", "note"], `${mode}: results are stored in the order the calls were made`)
  }
})

test("the connector carries a tool's read-only hint, and nothing else, from the server's tool list", async () => {
  const input = { type: "object" }
  const rpc = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.object({ protocolVersion: z.string().optional() }).loose().optional() })
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") return void response.writeHead(405).end()
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body = rpc.parse(JSON.parse(Buffer.concat(chunks).toString()))
    if (body.id === undefined) return void response.writeHead(202).end()
    const result = body.method === "initialize"
      ? { protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-apps", version: "1" } }
      : { tools: [
          { name: "search_mail", description: "Search mail", inputSchema: input, annotations: { readOnlyHint: true, openWorldHint: true } },
          { name: "send_mail", description: "Send mail", inputSchema: input, annotations: { readOnlyHint: false, idempotentHint: true } },
          { name: "archive_mail", description: "Archive mail", inputSchema: input },
        ] }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const session = await remoteMcpConnector({ url: `http://127.0.0.1:${address.port}/mcp`, allowlist: [], reservedNames: new Set() })({ token: "token", signal: new AbortController().signal })
    assert.deepEqual(session.tools, [
      { name: "search_mail", description: "Search mail", inputSchema: input, readOnly: true },
      { name: "send_mail", description: "Send mail", inputSchema: input },
      { name: "archive_mail", description: "Archive mail", inputSchema: input },
    ])
    await session.close()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("a long turn sends only its newest screenshots and files: older ones go in one cut, with a note, and the request then starts the same way", () => {
  const person: Message = { role: "user", text: "Fill in the form", images: [{ mediaType: "image/png", data: "their-own-photo" }] }
  /** A turn of `steps` tool results, each with what `attach` gives it. */
  const turn = (steps: number, attach: (step: number) => Pick<ToolMessage, "images" | "documents">): StoredMessage[] => [
    { seq: 0, messageId: "m1", message: person },
    ...Array.from({ length: steps }, (_, step): StoredMessage[] => [
      { seq: step * 2 + 1, messageId: "m1", message: { role: "assistant", text: "", toolCalls: [{ id: `call_${step}`, name: "desktop", input: { step } }] } },
      { seq: step * 2 + 2, messageId: "m1", message: { role: "tool", callId: `call_${step}`, name: "desktop", output: `Step ${step} done`, isError: false, ...attach(step) } },
    ]).flat(),
  ]
  const results = (rows: StoredMessage[]) => buildContext(rows, "m1", 100_000).messages.filter((message): message is ToolMessage => message.role === "tool")
  const screenshot = (step: number) => ({ images: [{ mediaType: "image/png", data: `screenshot-${step}` }] })
  const shown = (messages: ToolMessage[]) => messages.map((message) => message.images?.length ?? 0)

  // Up to the limit every screenshot is sent.
  assert.deepEqual(shown(results(turn(TURN_IMAGES, screenshot))), Array.from({ length: TURN_IMAGES }, () => 1))
  // One more, and the oldest go together; the newest stay.
  const cut = results(turn(TURN_IMAGES + 1, screenshot))
  assert.deepEqual(shown(cut), [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  assert.equal(cut[0]?.output, `Step 0 done\n${TRIMMED_TOOL_ATTACHMENTS}`, "its text stays, with a note that the screenshot is gone")
  assert.equal(cut[0]?.documents, undefined)
  assert.equal(cut[8]?.output, "Step 8 done")
  assert.deepEqual(cut.at(-1)?.images, [{ mediaType: "image/png", data: `screenshot-${TURN_IMAGES}` }])
  // The following steps send the same results as they were, so the request's start stays cached...
  for (let steps = TURN_IMAGES + 2; steps <= TURN_IMAGES + 8; steps += 1) assert.deepEqual(results(turn(steps, screenshot)).slice(0, cut.length), cut, `${steps} steps`)
  // ...until the screenshots kept since reach the limit again.
  assert.deepEqual(shown(results(turn(TURN_IMAGES + 9, screenshot))), [...Array.from({ length: 16 }, () => 0), ...Array.from({ length: 9 }, () => 1)])

  // Files count by their size: 6 MB of base64 each, and a request carries 20 MB of them.
  const data = "A".repeat(6_000_000)
  const pdf = (step: number) => ({ documents: [{ mediaType: "application/pdf" as const, data, name: `report-${step}.pdf` }] })
  assert.deepEqual(results(turn(3, pdf)).map((message) => message.documents?.length ?? 0), [1, 1, 1])
  const files = results(turn(4, pdf))
  assert.deepEqual(files.map((message) => message.documents?.length ?? 0), [0, 0, 1, 1])
  assert.ok(files[1]?.output.endsWith(TRIMMED_TOOL_ATTACHMENTS))

  // The newest result keeps what it returned, however much, and what the person sent is never touched.
  const many = { images: Array.from({ length: TURN_IMAGES + 4 }, (_, index) => ({ mediaType: "image/png", data: `frame-${index}` })) }
  const frames = buildContext(turn(2, (step) => (step === 1 ? many : screenshot(step))), "m1", 100_000).messages
  assert.deepEqual(frames.flatMap((message) => (message.role === "tool" ? [message.images?.length ?? 0] : [])), [0, TURN_IMAGES + 4])
  assert.deepEqual(frames.flatMap((message) => (message.role === "user" ? [message.images] : [])), [person.images])
})

test("a failed connection to the person's apps is tried again; the turn fails only when it keeps failing, and Stop ends the wait", async () => {
  const model: ModelClient = {
    async complete(request) {
      return request.messages.some((message) => message.role === "tool")
        ? { text: "A design review at 3:30.", toolCalls: [], usage }
        : { text: "Let me look.", toolCalls: [{ id: "call_1", name: "lookup", input: {} }], usage }
    },
  }
  for (const execution of [undefined, "steps" as const]) {
    const mode = execution ?? "one go"
    const waits: number[] = []
    let connects = 0
    let refused = 1
    const mcp: McpConnector = async () => {
      connects += 1
      if (connects <= refused) throw new Error("connection refused")
      return { tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }], async call() { return { output: "3:30 design review", isError: false } }, async close() {} }
    }
    const noWait = async (ms: number) => void waits.push(ms)

    // Refused once: connected on the next try, and the turn goes on as if nothing happened.
    using flaky = setup(model, mcp, { sleep: noWait })
    flaky.runner.send({ sessionId: flaky.session, messageId: "m1", prompt: "Check my calendar", credentials: { mcpToken: "token" }, execution })
    await flaky.runner.idle()
    assert.equal(flaky.store.getTurn(flaky.session, "m1")?.status, "completed", mode)
    assert.deepEqual(waits, [MCP_CONNECT_RETRY_MS[0]], mode)
    // A step-mode turn connects for each of its two steps.
    assert.equal(connects, execution ? 3 : 2, mode)

    // Refused every time: the turn fails as before, after the retries.
    connects = 0
    refused = Number.POSITIVE_INFINITY
    waits.length = 0
    using down = setup(model, mcp, { sleep: noWait })
    down.runner.send({ sessionId: down.session, messageId: "m1", prompt: "Check my calendar", credentials: { mcpToken: "token" }, execution })
    await down.runner.idle()
    const failed = down.store.getTurn(down.session, "m1")
    assert.deepEqual([failed?.status, failed?.error], ["failed", "mcp_unavailable"], mode)
    assert.equal(connects, MCP_CONNECT_RETRY_MS.length + 1, mode)
    assert.deepEqual(waits, MCP_CONNECT_RETRY_MS, mode)
    assert.deepEqual(down.store.turnMessages(down.session, "m1").map(({ message }) => message.role), ["user"], `${mode}: the model was never called`)

    // Stopped while it waits to connect again: the turn ends stopped, not failed.
    connects = 0
    let waiting: () => void = () => undefined
    const reached = new Promise<void>((resolve) => {
      waiting = resolve
    })
    using stopped = setup(model, mcp, { sleep: (ms, signal) => { waiting(); return sleep(60_000, signal) } })
    stopped.runner.send({ sessionId: stopped.session, messageId: "m1", prompt: "Check my calendar", credentials: { mcpToken: "token" }, execution })
    await reached
    assert.ok(stopped.runner.abort(stopped.session))
    await stopped.runner.idle()
    assert.equal(stopped.store.getTurn(stopped.session, "m1")?.status, "aborted", mode)
    assert.equal(connects, 1, mode)
  }
})

test("a turn that keeps making model calls ends at the step limit, as failed with max_steps_exceeded", async () => {
  for (const execution of [undefined, "steps" as const]) {
    let calls = 0
    // Never finishes on its own, and never repeats itself, so the stuck check doesn't stop it.
    const model: ModelClient = {
      async complete() {
        calls += 1
        return { text: "", toolCalls: [{ id: `call_${calls}`, name: "write_file", input: { path: "notes.md", content: `draft ${calls}` } }], usage }
      },
    }
    using world = setup(model, undefined, { limits: { ...limits, maxSteps: 3 } })
    world.runner.send({ sessionId: world.session, messageId: "m1", prompt: "Keep improving the notes", credentials: {}, execution })
    await world.runner.idle()
    const mode = execution ?? "one go"
    const turn = world.store.getTurn(world.session, "m1")
    assert.deepEqual([turn?.status, turn?.error], ["failed", "max_steps_exceeded"], mode)
    assert.equal(calls, 3, mode)
    // Every step it took is kept, each call with its result.
    assert.deepEqual(world.store.turnMessages(world.session, "m1").map(({ message }) => message.role), ["user", "assistant", "tool", "assistant", "tool", "assistant", "tool"], mode)
    assert.equal(world.store.readFile(world.session, "notes.md"), "draft 3", mode)
  }
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

test("a session has no step limit of its own: a request that sends one is refused and the runner's limit applies", async () => {
  for (const execution of [undefined, "steps" as const]) {
    const mode = execution ?? "one go"
    let calls = 0
    // Never repeats itself, so the stuck check doesn't stop it, and never finishes on its own.
    const model: ModelClient = {
      async complete() {
        calls += 1
        return { text: "", toolCalls: [{ id: `call_${calls}`, name: "write_file", input: { path: "notes.md", content: `draft ${calls}` } }], usage }
      },
    }
    using world = setup(model, undefined, { limits: { ...limits, maxSteps: 3 } })
    const app = createApp({ store: world.store, runner: world.runner, apiToken })
    const put = (body: Record<string, unknown>) =>
      app.request(`/v1/sessions/${world.session}`, { method: "PUT", headers: { authorization: `Bearer ${apiToken}` }, body: JSON.stringify(body) })
    // What an older caller still sends: no limit, a higher one, or clearing one.
    for (const maxSteps of [0, 50, null]) assert.equal((await put({ maxSteps })).status, 400, `${mode} ${String(maxSteps)}`)
    assert.equal((await put({ title: "Notes" })).status, 200, mode)
    world.runner.send({ sessionId: world.session, messageId: "m1", prompt: "Keep improving the notes", credentials: {}, execution })
    await world.runner.idle()
    const turn = world.store.getTurn(world.session, "m1")
    assert.deepEqual({ status: turn?.status, error: turn?.error ?? null, calls }, { status: "failed", error: "max_steps_exceeded", calls: 3 }, mode)
  }
})

test("deleting a conversation's computer keeps the conversation, and waits while it answers", async () => {
  using world = setup({ async complete() { return { text: "", toolCalls: [], usage } } })
  const deleted: string[] = []
  const computer: SessionComputer = {
    prompt: "", tools: [], toolNames: new Set(), image: "test",
    run: async () => ({ output: "" }), known: () => false, prewarm: () => undefined, release: () => undefined,
    delete: async (sessionId) => void deleted.push(sessionId), previewSavedFile: async () => undefined,
  }
  const app = createApp({ store: world.store, runner: world.runner, apiToken, computer })
  const remove = (sessionId: string) => app.request(`/v1/sessions/${sessionId}/computer`, { method: "DELETE", headers: { authorization: `Bearer ${apiToken}` } })
  seedTurn(world.store, world.session, "m1")

  assert.equal((await remove(world.session)).status, 204)
  assert.deepEqual(deleted, [world.session])
  assert.deepEqual((await readSession(app, world.session)).turns.map((turn) => turn.messageId), ["m1"], "the conversation and its messages stay")

  assert.equal((await remove("hs_nobodys_chat")).status, 404)
  world.store.admitTurn({ sessionId: world.session, messageId: "m2", prompt: "still answering", model: null })
  assert.equal((await remove(world.session)).status, 409, "never under a running answer")
  assert.deepEqual(deleted, [world.session])
})
