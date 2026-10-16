import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { denResumeClient, RESUME_EXCHANGE_PATH } from "../src/den-resume.js"
import type { ErrorReport, ErrorReporter } from "../src/error-reporting.js"
import type { McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { grantVault } from "../src/resume-grants.js"
import { Runner, type RunnerOptions } from "../src/runner.js"
import { SelfResume } from "../src/self-resume.js"
import { Store } from "../src/store.js"
import type { Message } from "../src/types.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const apiToken = "test-token-0123456789-0123456789-0123456789"
const callbackToken = "callback-token-0123456789-0123456789"
const grantKey = "grant-key-0123456789-0123456789-0123456789"
const GRANT = `hrg_${"A".repeat(20)}${"b".repeat(20)}_-9`
const OTHER_GRANT = `hrg_${"Z".repeat(43)}`
const unlimited = { maxConcurrentTurns: 4, maxSteps: 20, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The text of the newest user message (without the runner's sent-at line). */
const promptOf = (request: ModelRequest) => {
  const last = request.messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user").at(-1)
  return last?.text.split("\n").slice(1).join("\n") ?? ""
}
/** Tool results since the newest user message. */
const resultsOf = (request: ModelRequest) => {
  const index = request.messages.findLastIndex((message) => message.role === "user")
  return request.messages.slice(index + 1).filter((message) => message.role === "tool")
}

type DenAnswer = { status: number; body: Record<string, unknown> }
/** Den's exchange endpoint: answers from `script` in order, then with fresh tokens. */
async function fakeDen(script: DenAnswer[] = []) {
  const calls: Array<{ authorization: string | undefined; grant: string; sessionId: string; messageId: string }> = []
  let issued = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    if (request.method !== "POST" || request.url !== RESUME_EXCHANGE_PATH) return void response.writeHead(404).end()
    const body = z.object({ grant: z.string(), sessionId: z.string(), messageId: z.string() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString()))
    calls.push({ authorization: request.headers.authorization, ...body })
    const answer = script.shift() ?? { status: 200, body: { mcpToken: `fresh-token-${++issued}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), readOnly: false } }
    response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    script,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function recordingErrors() {
  const reports: ErrorReport[] = []
  const errors: ErrorReporter = { enabled: true, report: async (report) => void reports.push(report) }
  return { errors, reports }
}

/** One runner over a database file (several runners over the same file stand in for restarts). */
function world(directory: string, input: { model: ModelClient; mcp?: McpConnector; den?: string; clock?: () => number; limits?: Partial<RunnerOptions["limits"]>; errors?: ErrorReporter }) {
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  const recovered = store.recoverInterruptedTurns()
  const resume = input.den
    ? new SelfResume({ store, vault: grantVault(grantKey), exchange: denResumeClient({ url: input.den, token: callbackToken }), errors: input.errors, now: input.clock, random: () => 1 })
    : undefined
  const runner = new Runner({ store, model: input.model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits: { ...unlimited, ...input.limits }, mcp: input.mcp, resume, errors: input.errors })
  return { store, runner, resume, recovered, app: createApp({ store, runner, apiToken }) }
}

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "headless-self-resume-"))
  return { directory, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

const rawGrants = (store: Store) =>
  z.array(z.object({ message_id: z.string(), resume_grant: z.string().nullable() })).parse(store.db.prepare("SELECT message_id, resume_grant FROM turns ORDER BY rowid").all())

const answers: ModelClient = { complete: async () => ({ text: "Done.", toolCalls: [], usage }) }

test("self-resume needs all three settings, and Den's URL may be a private service", () => {
  const base = { HEADLESS_API_TOKEN: apiToken, HEADLESS_MODEL_PROTOCOL: "openai", HEADLESS_MODEL_BASE_URL: "http://127.0.0.1:1", HEADLESS_MODEL: "test-model" }
  const all = { HEADLESS_DEN_API_URL: "https://api.example.test/", HEADLESS_DEN_CALLBACK_TOKEN: callbackToken, HEADLESS_GRANT_KEY: grantKey }
  assert.equal(loadConfig(base).selfResume, undefined)
  assert.equal(loadConfig({ ...base, HEADLESS_DEN_API_URL: "", HEADLESS_DEN_CALLBACK_TOKEN: "", HEADLESS_GRANT_KEY: "" }).selfResume, undefined)
  assert.deepEqual(loadConfig({ ...base, ...all }).selfResume, { denApiUrl: "https://api.example.test", callbackToken, grantKey })
  assert.equal(loadConfig({ ...base, ...all, HEADLESS_DEN_API_URL: "http://den-api:8787" }).selfResume?.denApiUrl, "http://den-api:8787")
  assert.throws(() => loadConfig({ ...base, ...all, HEADLESS_DEN_API_URL: "http://den.example.test" }), /HEADLESS_DEN_API_URL/)
  assert.throws(() => loadConfig({ ...base, HEADLESS_DEN_API_URL: all.HEADLESS_DEN_API_URL }), /missing HEADLESS_DEN_CALLBACK_TOKEN, HEADLESS_GRANT_KEY/)
  assert.throws(() => loadConfig({ ...base, ...all, HEADLESS_GRANT_KEY: "short" }), /HEADLESS_GRANT_KEY/)
  assert.throws(() => loadConfig({ ...base, ...all, HEADLESS_DEN_CALLBACK_TOKEN: undefined }), /missing HEADLESS_DEN_CALLBACK_TOKEN/)
})

test("without self-resume a grant is accepted and ignored; a malformed one is refused", async () => {
  using temp = tempDir()
  const { store, runner, app } = world(temp.directory, { model: answers })
  const session = store.createSession({})
  const send = (credentials: Record<string, unknown>, messageId: string) =>
    app.request(`/v1/sessions/${session.id}/turns`, { method: "POST", headers: { authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ messageId, prompt: "Hi", credentials }) })
  assert.equal((await send({ mcpToken: "token", resumeGrant: GRANT }, "m1")).status, 202)
  assert.equal((await send({ resumeGrant: "hrg_short" }, "m2")).status, 400)
  assert.equal((await send({ resumeGrant: `xyz_${"A".repeat(43)}` }, "m3")).status, 400)
  await runner.idle()
  assert.equal(store.getTurn(session.id, "m1")?.status, "completed")
  assert.deepEqual(rawGrants(store), [{ message_id: "m1", resume_grant: null }])
  assert.equal((await runner.selfResume()).resumed, 0)
})

test("a grant is kept encrypted, never exported, and an export without it still imports", async () => {
  using temp = tempDir()
  await using den = await fakeDen()
  const { store, runner, app } = world(temp.directory, { model: answers, den: den.url })
  const session = store.createSession({ owner: "test" })
  const auth = { authorization: `Bearer ${apiToken}` }
  const sent = await app.request(`/v1/sessions/${session.id}/turns`, { method: "POST", headers: auth, body: JSON.stringify({ messageId: "m1", prompt: "Hi", credentials: { mcpToken: "token", resumeGrant: GRANT } }) })
  assert.equal(sent.status, 202)
  assert.ok(!(await sent.text()).includes(GRANT), "the turn a caller reads back has no grant")
  await runner.idle()

  const [row] = rawGrants(store)
  assert.ok(row?.resume_grant, "the grant is kept")
  assert.ok(!row.resume_grant.includes(GRANT) && !row.resume_grant.includes(GRANT.slice(4, 30)), "not in plaintext")
  assert.equal(await grantVault(grantKey).open(row.resume_grant), GRANT)
  assert.equal(await grantVault(`${grantKey}-another`).open(row.resume_grant), null, "another key opens nothing")
  assert.equal(await grantVault(grantKey).open(`${row.resume_grant.slice(0, -2)}AA`), null, "a changed value opens nothing")
  // Two seals of one grant differ (random IV).
  assert.notEqual(await grantVault(grantKey).seal(GRANT), await grantVault(grantKey).seal(GRANT))

  const exported = await app.request(`/v1/sessions/${session.id}/export`, { headers: auth })
  assert.equal(exported.status, 200)
  const text = await exported.text()
  assert.ok(!text.includes("resume_grant") && !text.includes(row.resume_grant) && !text.includes(GRANT))
  using target = tempDir()
  const other = world(target.directory, { model: answers, den: den.url })
  const imported = await other.app.request(`/v1/sessions/${session.id}/import`, { method: "POST", headers: auth, body: text })
  assert.equal(imported.status, 201, await imported.clone().text())
  assert.equal(other.store.getTurn(session.id, "m1")?.status, "completed")
  // A grant in an import (from a runner with another key) is never written.
  using third = tempDir()
  const withGrant = z.object({ turns: z.array(z.record(z.string(), z.unknown())) }).loose().parse(JSON.parse(text))
  const smuggled = { ...withGrant, turns: withGrant.turns.map((turn) => ({ ...turn, resume_grant: row.resume_grant })) }
  const elsewhere = world(third.directory, { model: answers, den: den.url })
  assert.equal((await elsewhere.app.request(`/v1/sessions/${session.id}/import`, { method: "POST", headers: auth, body: JSON.stringify(smuggled) })).status, 201)
  assert.deepEqual(rawGrants(elsewhere.store), [{ message_id: "m1", resume_grant: null }])
  assert.equal(den.calls.length, 0)
})

test("a long turn with a grant gets a fresh token in place and never pauses", async () => {
  using temp = tempDir()
  await using den = await fakeDen()
  const connections: string[] = []
  const toolTokens: string[] = []
  const mcp: McpConnector = async ({ token }) => {
    connections.push(token)
    return {
      tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }],
      call: async () => {
        toolTokens.push(token)
        return { output: `result ${toolTokens.length}`, isError: false }
      },
      close: async () => undefined,
    }
  }
  const model: ModelClient = {
    async complete(request) {
      await sleep(40)
      const results = resultsOf(request).length
      return results < 4 ? { text: "", toolCalls: [{ id: `call_${results}`, name: "lookup", input: { step: results } }], usage } : { text: "All looked up.", toolCalls: [], usage }
    },
  }
  const { errors, reports } = recordingErrors()
  const { store, runner } = world(temp.directory, { model, mcp, den: den.url, errors, limits: { credentialRefreshMs: 60 } })
  const statuses: string[] = []
  const onChange = store.onChange
  store.onChange = (sessionId, messageId, status) => {
    if (status) statuses.push(status)
    onChange?.(sessionId, messageId, status)
  }
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "long", prompt: "Look up four things", credentials: { mcpToken: "caller-token", resumeGrant: GRANT } })
  await runner.idle()

  assert.equal(store.getTurn(session.id, "long")?.status, "completed")
  assert.ok(!statuses.includes("interrupted"), `never paused: ${statuses.join(" → ")}`)
  assert.ok(den.calls.length >= 1, "exchanged its grant")
  for (const call of den.calls) assert.deepEqual(call, { authorization: `Bearer ${callbackToken}`, grant: GRANT, sessionId: session.id, messageId: "long" })
  assert.equal(connections[0], "caller-token")
  assert.deepEqual(connections.slice(1), den.calls.map((_, index) => `fresh-token-${index + 1}`), "reconnected with each fresh token")
  assert.equal(toolTokens[0], "caller-token")
  assert.ok(toolTokens.includes("fresh-token-1"), `app calls after the refresh use the fresh token: ${toolTokens.join(", ")}`)
  assert.deepEqual(reports, [])

  // Den refusing the grant for good: the turn pauses as before, and the grant is forgotten.
  den.script.push({ status: 403, body: { error: "grant_revoked" } })
  connections.length = 0
  runner.send({ sessionId: session.id, messageId: "revoked", prompt: "Look up four things", credentials: { mcpToken: "caller-token", resumeGrant: OTHER_GRANT } })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "revoked")?.status, "interrupted")
  assert.equal(store.getTurn(session.id, "revoked")?.error, "credentials_refresh")
  assert.equal(store.resumeGrantOf(session.id, "revoked"), null)
  assert.equal((await runner.selfResume()).resumed, 0)
  assert.equal(den.calls.at(-1)?.grant, OTHER_GRANT)
})

test("after a restart the runner resumes a cut-off turn and its task itself, with the message's grant", async () => {
  using temp = tempDir()
  await using den = await fakeDen()
  let lookups = 0
  const hang = new Promise<never>(() => undefined)
  // Before the restart: the message starts a task and answers; the task's app call never returns (the process dies).
  const firstMcp: McpConnector = async () => ({
    tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }],
    call: async () => {
      lookups += 1
      return hang
    },
    close: async () => undefined,
  })
  const tokensAfter: string[] = []
  const afterMcp: McpConnector = async ({ token }) => {
    tokensAfter.push(token)
    return { tools: [{ name: "lookup", description: "Looks something up", inputSchema: { type: "object" } }], call: async () => ({ output: "unused", isError: false }), close: async () => undefined }
  }
  const seen: ModelRequest[] = []
  const model: ModelClient = {
    async complete(request) {
      seen.push(request)
      const prompt = promptOf(request)
      const results = resultsOf(request)
      if (prompt === "Research this in the background") {
        return results.length ? { text: "Started it.", toolCalls: [], usage } : { text: "", toolCalls: [{ id: "call_start", name: "start_task", input: { title: "Research", brief: "Do the research" } }], usage }
      }
      if (prompt === "Do the research") {
        return results.length ? { text: "Research done.", toolCalls: [], usage } : { text: "", toolCalls: [{ id: "call_lookup", name: "lookup", input: {} }], usage }
      }
      return { text: "Your research is done.", toolCalls: [], usage }
    },
  }
  const before = world(temp.directory, { model, mcp: firstMcp, den: den.url })
  const session = before.store.createSession({ tasks: true })
  before.runner.send({ sessionId: session.id, messageId: "msg", prompt: "Research this in the background", credentials: { mcpToken: "caller-token", resumeGrant: GRANT } })
  for (let waited = 0; lookups === 0 && waited < 5_000; waited += 10) await sleep(10)
  await before.resume?.settled()
  assert.equal(lookups, 1)
  assert.equal(before.store.getTurn(session.id, "msg")?.status, "completed")
  assert.equal(before.store.getTurn(session.id, "msg.t1")?.status, "running")
  assert.deepEqual(rawGrants(before.store).map((row) => [row.message_id, row.resume_grant !== null]), [["msg", true], ["msg.t1", false]])

  // The restart: a new process over the same database. Nobody re-sends anything.
  const { errors, reports } = recordingErrors()
  const after = world(temp.directory, { model, mcp: afterMcp, den: den.url, errors })
  assert.equal(after.recovered, 1)
  assert.equal(after.store.getTurn(session.id, "msg.t1")?.error, "runner_restarted")
  assert.deepEqual(await after.runner.selfResume(), { resumed: 1, waiting: 0, failed: 0 })
  await after.runner.idle()

  assert.equal(after.store.getTurn(session.id, "msg.t1")?.status, "completed")
  assert.equal(after.store.getTurn(session.id, "msg.t1.r")?.status, "completed")
  assert.deepEqual(den.calls, [{ authorization: `Bearer ${callbackToken}`, grant: GRANT, sessionId: session.id, messageId: "msg.t1" }])
  assert.deepEqual(tokensAfter, ["fresh-token-1"])
  // The app call cut off by the restart is recorded as interrupted and never run again.
  assert.equal(lookups, 1)
  const cut = after.store.turnMessages(session.id, "msg.t1").find(({ message }) => message.role === "tool")?.message
  assert.ok(cut?.role === "tool" && cut.isError && cut.output.includes("not retried"))
  assert.deepEqual(reports, [])
  assert.equal((await after.runner.selfResume()).resumed, 0, "nothing left to resume")

  // A report cut off at shutdown resumes with the message's grant too, through its task.
  after.store.setTurnStatus(session.id, "msg.t1.r", "interrupted", "runner_shutdown")
  assert.equal(after.store.resumeGrantOf(session.id, "msg.t1.r")?.holder, "msg")
  assert.equal((await after.runner.selfResume()).resumed, 1)
  await after.runner.idle()
  assert.equal(after.store.getTurn(session.id, "msg.t1.r")?.status, "completed")
  assert.deepEqual(den.calls.at(-1), { authorization: `Bearer ${callbackToken}`, grant: GRANT, sessionId: session.id, messageId: "msg.t1.r" })
})

test("a turn without a grant, aborted, failed or resumed by its caller is left alone", async () => {
  using temp = tempDir()
  await using den = await fakeDen()
  const { store, runner } = world(temp.directory, { model: answers, den: den.url })
  const session = store.createSession({})
  const sealed = await grantVault(grantKey).seal(GRANT)
  for (const [messageId, status, error, grant] of [
    ["no_grant", "interrupted", "runner_restarted", null],
    ["aborted", "aborted", null, sealed],
    ["failed", "failed", "runner_restarted", sealed],
    ["other_reason", "interrupted", "model_http_500", sealed],
    ["unreadable", "interrupted", "runner_restarted", "v1.AAAA.BBBB"],
  ] as const) {
    store.admitTurn({ sessionId: session.id, messageId, prompt: "Hi", model: null })
    store.setTurnStatus(session.id, messageId, status, error)
    store.setResumeGrant(session.id, messageId, grant)
  }
  assert.deepEqual(await runner.selfResume(), { resumed: 0, waiting: 0, failed: 0 })
  assert.equal(den.calls.length, 0)
  assert.equal(store.resumeGrantOf(session.id, "unreadable"), null, "an unreadable grant is no grant")
  assert.equal(store.getTurn(session.id, "no_grant")?.status, "interrupted")
})

test("a grant Den refuses for good is not tried again, even after a restart; a refused runner stops asking", async () => {
  using temp = tempDir()
  await using den = await fakeDen([{ status: 403, body: { error: "grant_mismatch" } }])
  const { errors, reports } = recordingErrors()
  const first = world(temp.directory, { model: answers, den: den.url, errors })
  const session = first.store.createSession({})
  first.store.admitTurn({ sessionId: session.id, messageId: "m1", prompt: "Hi", model: null })
  first.store.setTurnStatus(session.id, "m1", "interrupted", "runner_restarted")
  first.store.setResumeGrant(session.id, "m1", await grantVault(grantKey).seal(GRANT))
  assert.deepEqual(await first.runner.selfResume(), { resumed: 0, waiting: 0, failed: 1 })
  assert.deepEqual(await first.runner.selfResume(), { resumed: 0, waiting: 0, failed: 0 })
  const again = world(temp.directory, { model: answers, den: den.url })
  assert.deepEqual(await again.runner.selfResume(), { resumed: 0, waiting: 0, failed: 0 })
  assert.equal(den.calls.length, 1)
  assert.equal(again.store.getTurn(session.id, "m1")?.status, "interrupted", "left for its caller")
  assert.deepEqual(reports.map((report) => [report.code, report.tags?.reason]), [["resume_exchange_failed", "grant_mismatch"]])

  // 401: the runner's own settings are wrong. Reported once; nothing more is exchanged in this process.
  again.store.setResumeGrant(session.id, "m1", await grantVault(grantKey).seal(GRANT))
  den.script.push({ status: 401, body: { error: "unauthorized" } })
  const refused = recordingErrors()
  const third = world(temp.directory, { model: answers, den: den.url, errors: refused.errors })
  await third.runner.selfResume()
  await third.runner.selfResume()
  assert.equal(den.calls.length, 2)
  assert.equal(third.resume?.usable, false)
  assert.equal(third.resume?.nextSweepAt(), null)
  assert.deepEqual(refused.reports.map((report) => report.code), ["resume_config_invalid"])
  assert.ok(third.store.resumeGrantOf(session.id, "m1"), "a configuration error keeps the grant for a fixed runner")
  const serialized = JSON.stringify([...reports, ...refused.reports])
  assert.ok(!serialized.includes(GRANT) && !serialized.includes("fresh-token"))
})

test("busy or unreachable Den: the turn waits longer each time, then resumes", async () => {
  using temp = tempDir()
  await using den = await fakeDen([
    { status: 503, body: { error: "exchange_failed" } },
    { status: 429, body: { error: "rate_limited", retryAfterMs: 120_000 } },
  ])
  let now = 1_000_000
  const { errors, reports } = recordingErrors()
  const { store, runner, resume } = world(temp.directory, { model: answers, den: den.url, clock: () => now, errors })
  const session = store.createSession({})
  store.admitTurn({ sessionId: session.id, messageId: "m1", prompt: "Hi", model: null })
  store.setTurnStatus(session.id, "m1", "interrupted", "credentials_refresh")
  store.setResumeGrant(session.id, "m1", await grantVault(grantKey).seal(GRANT))

  assert.equal(resume?.nextSweepAt(), now)
  assert.deepEqual(await runner.selfResume(), { resumed: 0, waiting: 0, failed: 1 }) // 503
  // 30 s, doubling from there (jitter fixed at its longest here).
  assert.equal(resume?.nextSweepAt(), now + 30_000)
  now += 10_000
  assert.deepEqual(await runner.selfResume(), { resumed: 0, waiting: 1, failed: 0 })
  now += 20_000
  assert.deepEqual(await runner.selfResume(), { resumed: 0, waiting: 0, failed: 1 }) // 429: Den's wait is longer than 60 s
  assert.equal(resume?.nextSweepAt(), now + 120_000)
  now += 100_000
  assert.deepEqual(await runner.selfResume(), { resumed: 0, waiting: 1, failed: 0 })
  now += 20_000
  assert.deepEqual(await runner.selfResume(), { resumed: 1, waiting: 0, failed: 0 })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "m1")?.status, "completed")
  assert.equal(den.calls.length, 3)
  assert.equal(resume?.nextSweepAt(), null)
  // Reported once for the turn, not on every retry.
  assert.deepEqual(reports.map((report) => [report.code, report.tags?.reason]), [["resume_exchange_failed", "den_http_503"]])

  // Den unreachable is retried the same way.
  const unreachable = new SelfResume({ store, vault: grantVault(grantKey), exchange: denResumeClient({ url: "http://127.0.0.1:9", token: callbackToken, timeoutMs: 2_000 }), now: () => now })
  store.setTurnStatus(session.id, "m1", "interrupted", "runner_restarted")
  assert.deepEqual(await unreachable.sweep(() => ({ ok: true, state: "resumed" })), { resumed: 0, waiting: 0, failed: 1 })
  assert.ok((unreachable.nextSweepAt() ?? 0) > now)
})

test("grants and tokens never reach the logs", async () => {
  using temp = tempDir()
  await using den = await fakeDen([{ status: 503, body: {} }])
  const logged: string[] = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  const capture = (...args: unknown[]) => void logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
  Object.assign(console, { log: capture, warn: capture, error: capture })
  try {
    const { store, runner } = world(temp.directory, { model: answers, den: den.url })
    const session = store.createSession({})
    store.admitTurn({ sessionId: session.id, messageId: "m1", prompt: "Hi", model: null })
    store.setTurnStatus(session.id, "m1", "interrupted", "runner_restarted")
    store.setResumeGrant(session.id, "m1", await grantVault(grantKey).seal(GRANT))
    await runner.selfResume()
    const resumed = world(temp.directory, { model: answers, den: den.url })
    await resumed.runner.selfResume()
    await resumed.runner.idle()
    assert.equal(resumed.store.getTurn(session.id, "m1")?.status, "completed")
  } finally {
    Object.assign(console, original)
  }
  assert.ok(logged.some((line) => line.includes("turn resumed by the runner")))
  assert.ok(logged.length > 0 && logged.every((line) => !line.includes(GRANT) && !line.includes("fresh-token") && !line.includes(callbackToken)), logged.join("\n"))
})
