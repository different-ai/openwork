/** Step mode (`execution: "steps"`, src/steps.ts): turns that run one step at a time from what is stored. */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { denResumeClient, RESUME_EXCHANGE_PATH } from "../src/den-resume.js"
import type { ErrorReport, ErrorReporter } from "../src/error-reporting.js"
import { readPart } from "../src/files.js"
import type { McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import type { SqlDriver } from "../src/sql.js"
import { grantVault } from "../src/resume-grants.js"
import { CUT_OFF_INSTRUCTION, Runner, type RunnerOptions } from "../src/runner.js"
import { SelfResume } from "../src/self-resume.js"
import { FRESH_REPEAT, type StepState } from "../src/steps.js"
import { Store } from "../src/store.js"
import type { Message } from "../src/types.js"

const usage = { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 }
const unlimited: RunnerOptions["limits"] = { maxConcurrentTurns: 4, maxSteps: 20, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
const callbackToken = "callback-token-0123456789-0123456789"
const grantKey = "grant-key-0123456789-0123456789-0123456789"
const GRANT = `hrg_${"A".repeat(20)}${"b".repeat(20)}_-9`
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** A model call or tool that never returns: the process running it is about to "die". */
const never = <T>() => new Promise<T>(() => undefined)

/** The newest user message's text, without the runner's sent-at line. */
const promptOf = (request: ModelRequest) => {
  const last = request.messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user").at(-1)
  return last?.text.split("\n").slice(1).join("\n") ?? ""
}
/** Tool results since the newest user message. */
const resultsOf = (request: ModelRequest) => {
  const index = request.messages.findLastIndex((message) => message.role === "user")
  return request.messages.slice(index + 1).filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool")
}

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "headless-steps-"))
  return { directory, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

function recordingErrors() {
  const reports: ErrorReport[] = []
  const errors: ErrorReporter = { enabled: true, report: async (report) => void reports.push(report) }
  return { errors, reports }
}

type WorldInput = {
  model: ModelClient
  mcp?: McpConnector
  den?: string
  alarm?: boolean
  clock?: () => number
  errors?: ErrorReporter
  limits?: Partial<RunnerOptions["limits"]>
  driver?: (db: SqlDriver) => SqlDriver
}

/**
 * One runner process over a database file, started the way both hosts start (startup recovery, then step-mode turns
 * continue). Several worlds over one file stand in for a process that died and the one that took over.
 */
function world(directory: string, input: WorldInput) {
  const db = nodeSqlite(join(directory, "runner.sqlite"))
  const store = new Store(input.driver ? input.driver(db) : db)
  const recovered = store.recoverInterruptedTurns()
  const resume = input.den
    ? new SelfResume({ store, vault: grantVault(grantKey), exchange: denResumeClient({ url: input.den, token: callbackToken }), random: () => 1 })
    : undefined
  const runner = new Runner({
    store,
    model: input.model,
    defaultModel: "test-model",
    defaultModelApiKey: "test-key",
    limits: { ...unlimited, ...input.limits },
    mcp: input.mcp,
    resume,
    errors: input.errors,
    now: input.clock,
    stepAlarm: input.alarm,
  })
  const steps = runner.recoverSteps()
  return { store, runner, recovered, steps }
}

/** Runs due steps from the "alarm" until none is due (or `max` rounds). */
async function drain(runner: Runner, store: Store, max = 50) {
  for (let round = 0; round < max; round += 1) {
    const due = store.nextStepAt()
    if (due === null || due > Date.now()) return
    await runner.runDueSteps()
  }
}

async function until(check: () => boolean, label: string, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

const transcript = (store: Store, sessionId: string, messageId: string) => store.turnMessages(sessionId, messageId).map(({ message }) => message)
const scheduleRows = (store: Store) => z.object({ n: z.number() }).parse(store.db.prepare("SELECT COUNT(*) AS n FROM step_schedule").get()).n

/** Den's resume-token exchange: a fresh token for every grant. */
async function fakeDen() {
  const calls: Array<{ grant: string; sessionId: string; messageId: string }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    if (request.method !== "POST" || request.url !== RESUME_EXCHANGE_PATH) return void response.writeHead(404).end()
    calls.push(z.object({ grant: z.string(), sessionId: z.string(), messageId: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString())))
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mcpToken: `fresh-token-${calls.length}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), readOnly: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Writes a note, reads it back, then answers: three steps with local file tools. */
const notesModel = (requests: ModelRequest[] = []): ModelClient => ({
  async complete(request) {
    requests.push(request)
    const results = resultsOf(request)
    request.onText?.(`step ${results.length}`)
    if (results.length === 0) return { text: "Writing it down.", toolCalls: [{ id: "call_write", name: "write_file", input: { path: "notes.md", content: "milk, eggs" } }], usage }
    if (results.length === 1) return { text: "", toolCalls: [{ id: "call_read", name: "read_file", input: { path: "notes.md" } }], usage }
    return { text: `Your list: ${results[1]?.output ?? "?"}`, toolCalls: [], usage }
  },
})

test("a step-mode turn ends with the same transcript, usage and files as the same turn run in one go", async () => {
  using a = tempDir()
  using b = tempDir()
  const continuousRequests: ModelRequest[] = []
  const stepRequests: ModelRequest[] = []
  const continuous = world(a.directory, { model: notesModel(continuousRequests) })
  const stepped = world(b.directory, { model: notesModel(stepRequests) })
  for (const [{ store, runner }, execution] of [[continuous, undefined], [stepped, "steps" as const]] as const) {
    store.putSession("hs_same_conversation", { owner: "test" })
    const sent = runner.send({ sessionId: "hs_same_conversation", messageId: "m1", prompt: "Remember milk and eggs", credentials: {}, ...(execution ? { execution } : {}) })
    assert.ok(sent.ok)
    await runner.idle()
  }
  const one = continuous.store.getTurn("hs_same_conversation", "m1")
  const two = stepped.store.getTurn("hs_same_conversation", "m1")
  assert.equal(two?.execution, "steps")
  assert.equal(one?.execution, undefined, "a turn sent without `execution` runs as before")
  assert.equal(two?.status, "completed")
  assert.equal(one?.status, "completed")
  assert.deepEqual(two?.usage, one?.usage)
  assert.deepEqual(transcript(stepped.store, "hs_same_conversation", "m1"), transcript(continuous.store, "hs_same_conversation", "m1"))
  assert.equal(stepped.store.readFile("hs_same_conversation", "notes.md"), "milk, eggs")
  // The model saw the same requests, step for step (the sent-at line aside, which carries the clock).
  const view = (requests: ModelRequest[]) => requests.map((request) => ({ system: request.system, tools: request.tools.map((tool) => tool.name), messages: request.messages.map((message) => (message.role === "user" ? promptOf({ ...request, messages: [message] }) : message)) }))
  assert.deepEqual(view(stepRequests), view(continuousRequests))
  assert.equal(scheduleRows(stepped.store), 0, "nothing left scheduled")
  assert.equal(stepped.store.stepCheckpoint("hs_same_conversation", "m1"), null)
})

test("a turn's log line says where its time went, step by step, in either mode", async (t) => {
  const lines: string[] = []
  const log = console.log
  t.mock.method(console, "log", (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[headless-runner] turn ended ")) lines.push(args[0])
    else log(...args)
  })
  for (const execution of [undefined, "steps" as const]) {
    using directory = tempDir()
    const { store, runner } = world(directory.directory, { model: notesModel() })
    store.putSession("hs_timed", { owner: "test" })
    assert.ok(runner.send({ sessionId: "hs_timed", messageId: "m1", prompt: "Remember milk and eggs", credentials: {}, ...(execution ? { execution } : {}) }).ok)
    await runner.idle()
  }
  assert.equal(lines.length, 2)
  for (const [index, line] of lines.entries()) {
    const { timing } = JSON.parse(line.slice("[headless-runner] turn ended ".length)) as { timing: { steps: Array<{ modelMs?: number; firstOutputMs?: number; tools?: Array<{ name: string; ms: number }> }>; modelMs: number; toolMs: number } }
    assert.deepEqual(timing.steps.map((step) => step.tools?.map((tool) => tool.name) ?? []), [["write_file"], ["read_file"], []])
    assert.ok(timing.steps.every((step) => typeof step.modelMs === "number"))
    // Step mode always streams, so each model call also says how soon it started writing.
    if (index === 1) assert.ok(timing.steps.every((step) => typeof step.firstOutputMs === "number"))
    assert.ok(timing.modelMs >= 0 && timing.toolMs >= 0)
  }
})

test("a step commits all of its messages, its next step and the attempt reset in one transaction, or none of them", () => {
  let fail = false
  const failing = (db: SqlDriver): SqlDriver => ({
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        ...statement,
        run: (...params) => {
          // The last write of a step that goes on: its next step.
          if (fail && sql.startsWith("UPDATE step_schedule SET due_at = ?, attempt = 0")) throw new Error("disk_gone")
          return statement.run(...params)
        },
      }
    },
  })
  using temp = tempDir()
  const { store } = world(temp.directory, { model: notesModel(), driver: failing })
  const session = store.createSession({})
  store.admitTurn({ sessionId: session.id, messageId: "m1", prompt: "Hi", model: null, execution: "steps" })
  const state: StepState = { v: 1, steps: 0, toolCalls: 0, stretchStartedAt: 0, repeat: FRESH_REPEAT, mcp: false, readOnly: false }
  store.beginStepRun(session.id, "m1", 0, state)
  store.startTranscript(session.id, "m1")
  store.startStepAttempt(session.id, "m1", 2, 5)
  store.saveCheckpoint(session.id, "m1", 0, "Writing it")
  fail = true
  const step = {
    sessionId: session.id,
    messageId: "m1",
    messages: [
      { role: "assistant" as const, text: "Writing it down.", toolCalls: [{ id: "c1", name: "write_file", input: {} }] },
      { role: "tool" as const, callId: "c1", name: "write_file", output: "ok", isError: false },
    ],
    usage,
    outcome: { next: { dueAt: 10, state: { ...state, steps: 1 } } },
  }
  assert.throws(() => store.commitStep(step), /disk_gone/)
  assert.equal(transcript(store, session.id, "m1").length, 1, "only the person's message: no half step")
  assert.deepEqual(store.getTurn(session.id, "m1")?.usage, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
  const row = store.stepRow(session.id, "m1")
  assert.ok(row && row !== "invalid")
  assert.equal(row.attempt, 2, "the attempt still counts")
  assert.equal(row.state.steps, 0)
  assert.equal(store.stepCheckpoint(session.id, "m1")?.text, "Writing it", "the checkpoint stays until the step commits")
  fail = false
  store.commitStep(step)
  assert.equal(transcript(store, session.id, "m1").length, 3)
  const next = store.stepRow(session.id, "m1")
  assert.ok(next && next !== "invalid")
  assert.deepEqual([next.attempt, next.dueAt, next.state.steps], [0, 10, 1])
  assert.equal(store.stepCheckpoint(session.id, "m1"), null)
})

test("a runner killed during a step's model call: the step runs again from the start, with no duplicate messages", async () => {
  using temp = tempDir()
  let calls = 0
  const model: ModelClient = {
    async complete(request) {
      calls += 1
      if (calls === 1) return never()
      return { text: "Here you go.", toolCalls: [], usage }
    },
  }
  const first = world(temp.directory, { model })
  const session = first.store.createSession({})
  first.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: { modelApiKey: "caller-key" }, execution: "steps" })
  await until(() => calls === 1, "the first model call")
  // The process dies here. The next one finds the turn running, with its step due.
  const second = world(temp.directory, { model })
  assert.equal(second.recovered, 0, "startup recovery leaves a step-mode turn going")
  assert.deepEqual(second.steps, { continued: 1, failed: 0 })
  await second.runner.idle()
  assert.equal(second.store.getTurn(session.id, "m1")?.status, "completed")
  assert.deepEqual(transcript(second.store, session.id, "m1").map((message) => message.role), ["user", "assistant"])
  assert.equal(calls, 2)
  assert.equal(scheduleRows(second.store), 0)
})

test("a tool call whose result wasn't recorded is never run again: the model gets an error and checks", async () => {
  await using den = await fakeDen()
  using temp = tempDir()
  let lookups = 0
  const tokens: string[] = []
  const requests: ModelRequest[] = []
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      if (resultsOf(request).length === 0) return { text: "Sending it.", toolCalls: [{ id: "call_send", name: "send_email", input: { to: "team" } }], usage }
      return { text: "I couldn't confirm it was sent; please check your outbox.", toolCalls: [], usage }
    },
  }
  const mcp: McpConnector = async ({ token }) => {
    tokens.push(token)
    return {
      tools: [{ name: "send_email", description: "Sends an email", inputSchema: { type: "object" } }],
      async call() {
        lookups += 1
        return lookups === 1 ? never() : { output: "sent", isError: false }
      },
      async close() {},
    }
  }
  const first = world(temp.directory, { model, mcp, den: den.url })
  const session = first.store.createSession({})
  first.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Email the team", credentials: { mcpToken: "caller-token", resumeGrant: GRANT }, execution: "steps" })
  await until(() => lookups === 1, "the email being sent")
  // Killed while the email was sending. The new process has no token: Den gives one for the turn's grant.
  const second = world(temp.directory, { model, mcp, den: den.url })
  await second.runner.idle()
  assert.equal(lookups, 1, "the call that may have sent the email did not run again")
  assert.equal(second.store.getTurn(session.id, "m1")?.status, "completed")
  const messages = transcript(second.store, session.id, "m1")
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"])
  const result = messages[2]
  assert.ok(result?.role === "tool" && result.isError && result.output.includes("not retried"))
  assert.equal(requests.length, 2, "the step finished from the kept answer, without asking the model again")
  assert.deepEqual(den.calls.map((call) => call.messageId), ["m1"], "fresh credentials from the turn's grant")
  assert.deepEqual(tokens, ["caller-token", "fresh-token-1"])
})

test("without a resume grant, a turn that lost its credentials is interrupted as on any restart, and resumes when re-sent", async () => {
  using temp = tempDir()
  let calls = 0
  const model: ModelClient = {
    async complete() {
      calls += 1
      return calls === 1 ? never() : { text: "Done.", toolCalls: [], usage }
    },
  }
  const mcp: McpConnector = async () => ({ tools: [], async call() { return { output: "", isError: false } }, async close() {} })
  const first = world(temp.directory, { model, mcp })
  const session = first.store.createSession({})
  first.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: { mcpToken: "caller-token" }, execution: "steps" })
  await until(() => calls === 1, "the model call")
  const second = world(temp.directory, { model, mcp })
  await second.runner.idle()
  const cut = second.store.getTurn(session.id, "m1")
  assert.equal(cut?.status, "interrupted")
  assert.equal(cut?.error, "runner_restarted")
  assert.equal(scheduleRows(second.store), 0)
  const resent = second.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: { mcpToken: "fresh-token" } })
  assert.ok(resent.ok && resent.state === "resumed")
  await second.runner.idle()
  const done = second.store.getTurn(session.id, "m1")
  assert.equal(done?.status, "completed")
  assert.equal(done?.execution, "steps", "a re-sent turn keeps its mode")
})

test("a step that keeps dying is retried at once, then after 30 s and 2 minutes, then fails with step_crash_loop", async () => {
  using temp = tempDir()
  let now = 1_000_000
  let calls = 0
  const model: ModelClient = {
    async complete() {
      calls += 1
      return never()
    },
  }
  const { errors, reports } = recordingErrors()
  const start = () => world(temp.directory, { model, alarm: true, clock: () => now, errors })
  let current = start()
  const session = current.store.createSession({})
  current.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: {}, execution: "steps" })
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (attempt === 4) {
      void current.runner.runDueSteps()
      await sleep(20)
      assert.equal(calls, 3, "the 4th attempt waits 30 s")
      now += 30_000
    }
    if (attempt === 5) {
      now += 119_000
      void current.runner.runDueSteps()
      await sleep(20)
      assert.equal(calls, 4, "the 5th attempt waits 2 minutes")
      now += 1_000
    }
    void current.runner.runDueSteps()
    await until(() => calls === attempt, `attempt ${attempt}`)
    const row = current.store.stepRow(session.id, "m1")
    assert.ok(row && row !== "invalid")
    assert.equal(row.attempt, attempt, "counted before the model call")
    // The cell dies in the step; another process takes over.
    current = start()
  }
  await current.runner.runDueSteps()
  const turn = current.store.getTurn(session.id, "m1")
  assert.equal(turn?.status, "failed")
  assert.equal(turn?.error, "step_crash_loop")
  assert.equal(calls, 5)
  assert.equal(scheduleRows(current.store), 0)
  assert.ok(reports.some((report) => report.code === "step_crash_loop" && report.kind === "turn_failed"), JSON.stringify(reports))
})

test("the alarm isn't kept set for a step still running here: only its next step, once it ends", async () => {
  using temp = tempDir()
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let calls = 0
  const model: ModelClient = {
    async complete(request) {
      calls += 1
      if (calls === 1) {
        await held
        return { text: "Noting it.", toolCalls: [{ id: "call_note", name: "write_file", input: { path: "a.md", content: "a" } }], usage }
      }
      return { text: `Answer to ${promptOf(request)}`, toolCalls: [], usage }
    },
  }
  const { store, runner } = world(temp.directory, { model, alarm: true })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: {}, execution: "steps" })
  const first = runner.nextStepAt()
  assert.ok(first !== null && first <= Date.now(), "the first step is due")
  const alarm = runner.runDueSteps()
  await until(() => calls === 1, "the first model call")
  const row = store.stepRow(session.id, "m1")
  assert.ok(row && row !== "invalid" && row.dueAt <= Date.now(), "due again at once, for a process that dies in the step")
  // An alarm for it would only find it running and set itself again; celld starts that alarm during a long one.
  assert.equal(runner.nextStepAt(), null)
  await runner.runDueSteps()
  assert.equal(calls, 1, "an alarm during the step doesn't start it again")
  release()
  await alarm
  const next = runner.nextStepAt()
  assert.ok(next !== null && next <= Date.now(), "its end sets the next step")
  await drain(runner, store)
  assert.equal(store.getTurn(session.id, "m1")?.status, "completed")
  assert.equal(calls, 2)
  assert.equal(runner.nextStepAt(), null)
})

test("an exception in one lane's step fails that turn only: other lanes and the alarm keep going", async () => {
  using temp = tempDir()
  const model: ModelClient = {
    async complete(request) {
      if (resultsOf(request).length === 0) return { text: "", toolCalls: [{ id: "call_look", name: "lookup", input: {} }], usage }
      return { text: `Answer to ${promptOf(request)}`, toolCalls: [], usage }
    },
  }
  const mcp: McpConnector = async ({ token }) => ({
    tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }],
    async call() {
      return { output: "found", isError: false }
    },
    async close() {
      if (token === "broken") throw new TypeError("close exploded")
    },
  })
  const { store, runner } = world(temp.directory, { model, mcp, alarm: true })
  const broken = store.createSession({})
  const fine = store.createSession({})
  runner.send({ sessionId: broken.id, messageId: "m1", prompt: "First", credentials: { mcpToken: "broken" }, execution: "steps" })
  runner.send({ sessionId: fine.id, messageId: "m1", prompt: "Second", credentials: { mcpToken: "fine" }, execution: "steps" })
  await drain(runner, store)
  const failed = store.getTurn(broken.id, "m1")
  assert.equal(failed?.status, "failed")
  assert.equal(failed?.error, "runner_error")
  assert.equal(store.getTurn(fine.id, "m1")?.status, "completed")
  assert.equal(scheduleRows(store), 0)
  // The cell still takes and runs new work.
  runner.send({ sessionId: broken.id, messageId: "m2", prompt: "Third", credentials: { mcpToken: "fine" }, execution: "steps" })
  await drain(runner, store)
  assert.equal(store.getTurn(broken.id, "m2")?.status, "completed")
})

test("startup never throws on a corrupt step row: that turn fails, and the others go on", async () => {
  using temp = tempDir()
  let calls = 0
  const model: ModelClient = {
    async complete(request) {
      calls += 1
      return calls <= 3 ? never() : { text: `Answer to ${promptOf(request)}`, toolCalls: [], usage }
    },
  }
  const first = world(temp.directory, { model })
  const ids = ["corrupt", "mistyped", "healthy"].map((title) => first.store.createSession({ title }).id)
  for (const id of ids) first.runner.send({ sessionId: id, messageId: "m1", prompt: "Hi", credentials: {}, execution: "steps" })
  await until(() => calls === 3, "three model calls")
  const [corrupt, mistyped, healthy] = ids
  first.store.db.prepare("UPDATE step_schedule SET state = '{not json' WHERE session_id = ?").run(corrupt ?? "")
  first.store.db.prepare("UPDATE step_schedule SET due_at = 'soon' WHERE session_id = ?").run(mistyped ?? "")
  const second = world(temp.directory, { model })
  assert.deepEqual(second.steps, { continued: 1, failed: 2 })
  await second.runner.idle()
  for (const id of [corrupt, mistyped]) {
    const turn = second.store.getTurn(id ?? "", "m1")
    assert.equal(turn?.status, "failed")
    assert.equal(turn?.error, "step_state_invalid")
  }
  assert.equal(second.store.getTurn(healthy ?? "", "m1")?.status, "completed")
})

test("background tasks and their reports run in step mode like the message that started them", async () => {
  using temp = tempDir()
  const model: ModelClient = {
    async complete(request) {
      if (request.system.includes("Only deliver the background task's result")) return { text: "Your research is done.", toolCalls: [], usage }
      if (request.messages.some((message) => message.role === "user" && message.text.endsWith("Research the market"))) return { text: "Market is up.", toolCalls: [], usage }
      if (!request.messages.some((message) => message.role === "tool")) return { text: "", toolCalls: [{ id: "call_task", name: "start_task", input: { title: "Market", brief: "Research the market" } }], usage }
      return { text: "Started it.", toolCalls: [], usage }
    },
  }
  const { store, runner } = world(temp.directory, { model })
  const session = store.createSession({ tasks: true })
  runner.send({ sessionId: session.id, messageId: "m1", prompt: "Look into the market", credentials: {}, execution: "steps" })
  await runner.idle()
  const turns = store.listTurns(session.id)
  assert.deepEqual(turns.map((turn) => [turn.messageId, turn.kind, turn.execution, turn.status]), [
    ["m1", undefined, "steps", "completed"],
    ["m1.t1", "task", "steps", "completed"],
    ["m1.t1.r", "report", "steps", "completed"],
  ])
})

test("a task works from files it is handed, and its report reads just the part it needs", async () => {
  using temp = tempDir()
  const script = Array.from({ length: 3000 }, (_, index) => (index === 2400 ? "bpy.ops.render.render(write_still=True)" : `line_${index} = ${index}`)).join("\n")
  const requests: ModelRequest[] = []
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      const results = resultsOf(request)
      if (request.system.includes("Only deliver the background task's result")) {
        if (!request.messages.some((message) => message.role === "tool" && message.output.startsWith("2401:"))) return { text: "", toolCalls: [{ id: "call_find", name: "read_file", input: { path: "out/scene.py", find: "render(" } }], usage }
        return { text: "It renders at line 2401.", toolCalls: [], usage }
      }
      if (request.system.includes("# Your background task")) {
        if (results.length === 0) return { text: "", toolCalls: [{ id: "call_write", name: "write_file", input: { path: "out/scene.py", content: script } }], usage }
        return { text: "Wrote the scene to out/scene.py.", toolCalls: [], usage }
      }
      const done = request.messages.filter((message) => message.role === "tool").length
      if (done === 0) return { text: "", toolCalls: [{ id: "call_notes", name: "write_file", input: { path: "plan.md", content: "two rooms" } }], usage }
      if (done === 1) return { text: "", toolCalls: [{ id: "call_task", name: "start_task", input: { title: "Scene", brief: "Build the scene from the plan", files: ["plan.md"] } }], usage }
      return { text: "Started it.", toolCalls: [], usage }
    },
  }
  const { store, runner } = world(temp.directory, { model })
  const session = store.createSession({ tasks: true })
  runner.send({ sessionId: session.id, messageId: "m1", prompt: "Build my apartment", credentials: {} })
  await runner.idle()
  assert.deepEqual(store.listTurns(session.id).map((turn) => [turn.messageId, turn.status]), [["m1", "completed"], ["m1.t1", "completed"], ["m1.t1.r", "completed"]])
  assert.match(promptOf(requests.find((request) => request.system.includes("# Your background task"))!), /Files for this task, in your scratch workspace:\n- plan\.md \(9 bytes\)/)
  const report = requests.find((request) => request.system.includes("Only deliver the background task's result"))!
  const delivered = report.messages.find((message): message is Extract<Message, { role: "user" }> => message.role === "user" && message.text.includes('Background task "Scene" finished'))?.text ?? ""
  assert.match(delivered, /Scratch files it wrote[^\n]*\n- out\/scene\.py \(\d+ KB\)/)
  assert.doesNotMatch(delivered, /plan\.md/, "files it was handed are not results")
  assert.deepEqual(report.tools.map((tool) => tool.name), ["list_files", "read_file"])
  assert.equal(store.getTurn(session.id, "m1.t1.r")?.status, "completed")
  assert.ok(transcript(store, session.id, "m1.t1.r").some((message) => message.role === "tool" && message.output === "2401: bpy.ops.render.render(write_still=True)"))
})

test("read_file reads a long file in numbered parts", () => {
  const content = Array.from({ length: 10 }, (_, index) => `row ${index + 1}`).join("\n")
  assert.equal(readPart(content, {}), content)
  assert.equal(readPart(content, { start: 4, lines: 2 }), "[lines 4-5 of 10]\n4: row 4\n5: row 5\n[continues at line 6]")
  assert.equal(readPart(content, { start: 9 }), "[lines 9-10 of 10]\n9: row 9\n10: row 10")
  assert.equal(readPart(content, { find: "ROW 1" }), "1: row 1\n10: row 10")
  assert.equal(readPart(content, { find: "nope" }), 'No line contains "nope" (10 lines).')
  const long = Array.from({ length: 5000 }, () => "x".repeat(20)).join("\n")
  assert.match(readPart(long, {}), /^\[lines 1-\d+ of 5000\][\s\S]*\[continues at line \d+\]$/)
})

test("stopping a step-mode turn between steps ends it at once; a follow-up wraps up an answer between steps", async () => {
  using temp = tempDir()
  const model: ModelClient = {
    async complete(request) {
      if (resultsOf(request).length === 0) return { text: "Noting it.", toolCalls: [{ id: "call_note", name: "write_file", input: { path: "a.md", content: "a" } }], usage }
      return { text: `Answer to ${promptOf(request)}`, toolCalls: [], usage }
    },
  }
  const { store, runner } = world(temp.directory, { model, alarm: true })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "m1", prompt: "First", credentials: {}, execution: "steps" })
  await runner.runDueSteps()
  assert.equal(store.getTurn(session.id, "m1")?.status, "running", "between steps")
  assert.ok(runner.abort(session.id, "m1"))
  assert.equal(store.getTurn(session.id, "m1")?.status, "aborted")
  assert.equal(scheduleRows(store), 0)

  runner.send({ sessionId: session.id, messageId: "m2", prompt: "Second", credentials: {}, execution: "steps" })
  await runner.runDueSteps()
  runner.send({ sessionId: session.id, messageId: "m3", prompt: "Actually, third", credentials: {}, execution: "steps", interrupt: true })
  const wrapped = store.getTurn(session.id, "m2")
  assert.equal(wrapped?.status, "aborted")
  assert.equal(wrapped?.error, "superseded")
  await drain(runner, store)
  assert.equal(store.getTurn(session.id, "m3")?.status, "completed")
  assert.ok(transcript(store, session.id, "m2").some((message) => message.role === "tool"), "the finished step is kept")
})

test("a step-mode turn whose token gets old pauses for credentials_refresh without a grant, as before", async () => {
  using temp = tempDir()
  const model: ModelClient = {
    async complete(request) {
      if (resultsOf(request).length === 0) return { text: "", toolCalls: [{ id: "call_look", name: "lookup", input: {} }], usage }
      return { text: "Done.", toolCalls: [], usage }
    },
  }
  const mcp: McpConnector = async () => ({
    tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }],
    async call() {
      await sleep(5)
      return { output: "found", isError: false }
    },
    async close() {},
  })
  const { store, runner } = world(temp.directory, { model, mcp, limits: { credentialRefreshMs: 1 } })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: { mcpToken: "token" }, execution: "steps" })
  await runner.idle()
  const turn = store.getTurn(session.id, "m1")
  assert.equal(turn?.status, "interrupted")
  assert.equal(turn?.error, "credentials_refresh")
  assert.equal(scheduleRows(store), 0)
})

test("a Node runner that shuts down mid-step leaves the turn to go on when it starts again, without counting a crash", async () => {
  using temp = tempDir()
  let calls = 0
  const model: ModelClient = {
    async complete(request) {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
      }
      return { text: "Done.", toolCalls: [], usage }
    },
  }
  const first = world(temp.directory, { model })
  const session = first.store.createSession({})
  first.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Hi", credentials: {}, execution: "steps" })
  first.runner.send({ sessionId: session.id, messageId: "m2", prompt: "Then this", credentials: {}, execution: "steps" })
  await until(() => calls === 1, "the model call")
  await first.runner.shutdown()
  assert.equal(first.store.getTurn(session.id, "m1")?.status, "running")
  assert.equal(first.store.getTurn(session.id, "m2")?.status, "queued")
  const row = first.store.stepRow(session.id, "m1")
  assert.ok(row && row !== "invalid")
  assert.equal(row.attempt, 0, "a shutdown is not a crash")
  const second = world(temp.directory, { model })
  assert.deepEqual(second.steps, { continued: 2, failed: 0 })
  await second.runner.idle()
  assert.equal(second.store.getTurn(session.id, "m1")?.status, "completed")
  assert.equal(second.store.getTurn(session.id, "m2")?.status, "completed")
})

test("a reply cut off at the output cap never ends the turn: it is dropped, the model is asked for less, and repeats fail", async () => {
  for (const execution of [undefined, "steps" as const]) {
    using temp = tempDir()
    const systems: string[] = []
    // Cut off twice (text only, then nothing), then answers.
    const model: ModelClient = {
      async complete(request) {
        systems.push(request.system)
        if (systems.length === 1) return { text: "Here is the whole scri", toolCalls: [], usage, cutOff: true }
        if (systems.length === 2) return { text: "", toolCalls: [], usage, cutOff: true }
        return { text: "Built it in parts.", toolCalls: [], usage }
      },
    }
    const { store, runner } = world(temp.directory, { model })
    store.putSession("hs_cut_off", { owner: "test" })
    runner.send({ sessionId: "hs_cut_off", messageId: "m1", prompt: "Model an apartment", credentials: {}, ...(execution ? { execution } : {}) })
    await runner.idle()
    await drain(runner, store)
    assert.equal(store.getTurn("hs_cut_off", "m1")?.status, "completed", `${execution ?? "one go"}`)
    assert.deepEqual(transcript(store, "hs_cut_off", "m1").filter((message) => message.role === "assistant").map((message) => message.text), ["Built it in parts."])
    assert.deepEqual(systems.map((system) => system.includes(CUT_OFF_INSTRUCTION)), [false, true, true])

    const always: ModelClient = { async complete() { return { text: "", toolCalls: [], usage, cutOff: true } } }
    using other = tempDir()
    const failing = world(other.directory, { model: always })
    failing.store.putSession("hs_cut_off", { owner: "test" })
    failing.runner.send({ sessionId: "hs_cut_off", messageId: "m1", prompt: "Model an apartment", credentials: {}, ...(execution ? { execution } : {}) })
    await failing.runner.idle()
    await drain(failing.runner, failing.store)
    const turn = failing.store.getTurn("hs_cut_off", "m1")
    assert.deepEqual([turn?.status, turn?.error], ["failed", "output_limit"], `${execution ?? "one go"}`)
  }
})
