/** Step mode with a member's scoped model access (#6206): every step uses it, nothing stores it, recovery re-obtains it. */
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import type { HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import { denResumeClient, type ResumeExchangeInput } from "../src/den-resume.js"
import { SessionEvents } from "../src/events.js"
import type { McpConnector } from "../src/mcp.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { grantVault } from "../src/resume-grants.js"
import { Runner, type RunnerOptions } from "../src/runner.js"
import { SelfResume } from "../src/self-resume.js"
import { Store } from "../src/store.js"
import type { Message } from "../src/types.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits: RunnerOptions["limits"] = { maxConcurrentTurns: 4, maxSteps: 20, turnTimeoutMs: Infinity, credentialRefreshMs: Infinity, contextCharBudget: 100_000 }
const access: HeadlessModelAccess = { baseUrl: "https://scoped.example.test/v1", apiKey: "opaque-member-credential", protocol: "openai" }
const grant = `hrg_${"A".repeat(43)}`
const vaultKey = "encryption-key-0123456789-0123456789"
/** The deployment's own adapter and key: a scoped turn must never reach them. */
const deploymentModel: ModelClient = { complete: async () => { throw new Error("deployment adapter must not be used") } }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const never = <T>() => new Promise<T>(() => undefined)

function database() {
  const directory = mkdtempSync(join(tmpdir(), "steps-scoped-model-"))
  const path = join(directory, "runner.sqlite")
  return { path, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

/** No inference credential anywhere SQLite keeps data: rows (step bookkeeping and checkpoints too), the file, the WAL. */
function assertNotStored(store: Store, path: string, sessionId: string) {
  const rows = JSON.stringify([
    store.exportConversation(sessionId),
    store.db.prepare("SELECT * FROM step_schedule").all(),
    store.db.prepare("SELECT * FROM step_checkpoints").all(),
  ])
  for (const secret of [access.apiKey, access.baseUrl]) {
    assert.ok(!rows.includes(secret), "no inference credential in any row")
    for (const file of [path, `${path}-wal`]) {
      if (existsSync(file)) assert.ok(!readFileSync(file).includes(Buffer.from(secret)), "no inference credential in the database or its WAL")
    }
  }
}

async function until(check: () => boolean, label: string, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

const hasResult = (request: ModelRequest) => request.messages.some((message) => message.role === "tool")

test("a step-mode turn on scoped model access uses it for every step, task and report, and stores none of it", async () => {
  using db = database()
  const store = new Store(nodeSqlite(db.path))
  const requests: ModelRequest[] = []
  const adapters: HeadlessModelAccess[] = []
  /** Raw step bookkeeping and checkpoints as they were while steps ran. */
  const seenRows: string[] = []
  const runner = new Runner({
    store,
    model: deploymentModel,
    defaultModel: "deployment-model",
    defaultModelApiKey: "shared-deployment-key",
    limits,
    events: new SessionEvents(),
    checkpointMs: 10,
    modelForAccess: (value) => {
      adapters.push(value)
      return {
        async complete(request) {
          requests.push(request)
          for (const word of ["Working", " on", " it."]) {
            request.onText?.(word)
            await sleep(15)
          }
          seenRows.push(JSON.stringify([store.db.prepare("SELECT * FROM step_schedule").all(), store.db.prepare("SELECT * FROM step_checkpoints").all()]))
          if (request.system.includes("Only deliver the background task's result")) return { text: "The check passed.", toolCalls: [], usage }
          if (request.messages.some((message: Message) => message.role === "user" && message.text.endsWith("Check the result"))) {
            return hasResult(request) ? { text: "Checked.", toolCalls: [], usage } : { text: "Noting it.", toolCalls: [{ id: "note", name: "write_file", input: { path: "check.md", content: "ok" } }], usage }
          }
          return hasResult(request) ? { text: "Started the check.", toolCalls: [], usage } : { text: "", toolCalls: [{ id: "task", name: "start_task", input: { title: "Check", brief: "Check the result" } }], usage }
        },
      }
    },
  })
  const session = store.createSession({ tasks: true })
  const sent = runner.send({ sessionId: session.id, messageId: "m1", prompt: "Check this", model: "member-model", execution: "steps", credentials: { modelAccess: access } })
  assert.ok(sent.ok)
  assert.ok(!JSON.stringify(sent).includes(access.apiKey) && !JSON.stringify(sent).includes(access.baseUrl))
  await runner.idle()

  const turns = store.listTurns(session.id)
  assert.deepEqual(turns.map((turn) => [turn.messageId, turn.status, turn.execution, turn.modelAccessRequired]), [
    ["m1", "completed", "steps", true],
    ["m1.t1", "completed", "steps", true],
    ["m1.t1.r", "completed", "steps", true],
  ], "tasks and reports inherit both step mode and the scoped-access requirement")
  assert.ok(requests.length >= 5, `every step ran: ${requests.length}`)
  assert.ok(requests.every((request) => request.apiKey === access.apiKey && request.model === "member-model"), "every step used the scoped key and the selected model")
  for (const value of adapters) assert.deepEqual(value, access)
  assert.ok(seenRows.some((rows) => rows.includes("Working")), "checkpoints were written while steps streamed")
  for (const rows of seenRows) assert.ok(!rows.includes(access.apiKey) && !rows.includes(access.baseUrl), "never in step bookkeeping or checkpoints")
  assertNotStored(store, db.path, session.id)
  store.close()
})

test("a scoped step-mode turn that lost its credentials re-obtains MCP and model access from Den, pinned to its model, or waits", async () => {
  using db = database()
  const vault = grantVault(vaultKey)
  const exchanges: ResumeExchangeInput[] = []
  let returnAccess = false
  const exchange = denResumeClient({ url: "https://den.example.test", token: "callback-secret", fetch: async (_url, init) => {
    const body = z.object({ grant: z.string(), sessionId: z.string(), messageId: z.string(), model: z.string().optional(), modelAccessRequired: z.boolean().optional() }).parse(JSON.parse(String(init?.body)))
    exchanges.push(body)
    return Response.json({ mcpToken: `fresh-mcp-${exchanges.length}`, readOnly: false, expiresAt: "2099-01-01T00:00:00Z", ...(returnAccess ? { modelAccess: access } : {}) })
  } })
  const tokens: string[] = []
  const mcp: McpConnector = async ({ token }) => {
    tokens.push(token)
    return { tools: [], async call() { return { output: "", isError: false } }, async close() {} }
  }
  const requests: ModelRequest[] = []
  /** One process over the database; the deployment default changes between them, which a scoped retry must ignore. */
  const start = (model: (request: ModelRequest) => ReturnType<ModelClient["complete"]>, defaultModel: string) => {
    const store = new Store(nodeSqlite(db.path))
    store.recoverInterruptedTurns()
    const resume = new SelfResume({ store, vault, exchange, random: () => 1 })
    const runner = new Runner({
      store,
      model: deploymentModel,
      defaultModel,
      defaultModelApiKey: "shared-deployment-key",
      limits,
      mcp,
      resume,
      modelForAccess: (value) => {
        assert.deepEqual(value, access)
        return { complete: (request) => { requests.push(request); return model(request) } }
      },
    })
    const steps = runner.recoverSteps()
    return { store, runner, steps }
  }

  const first = start(() => never(), "deployment-model")
  const session = first.store.createSession({})
  first.runner.send({ sessionId: session.id, messageId: "m1", prompt: "Continue this", model: "member-model", execution: "steps", credentials: { mcpToken: "caller-mcp", modelAccess: access, resumeGrant: grant } })
  await until(() => requests.length === 1, "the first step's model call")
  // The cell is switched or restarted here: everything held in memory, including model access, is gone.

  // Den answers without model access: the turn must not fall back to the deployment key; it waits, interrupted.
  const waiting = start(async (request) => ({ text: `Done on ${request.model}.`, toolCalls: [], usage }), "changed-deployment-model")
  assert.deepEqual(waiting.steps, { continued: 1, failed: 0 })
  await waiting.runner.idle()
  const interrupted = waiting.store.getTurn(session.id, "m1")
  assert.equal(interrupted?.status, "interrupted")
  assert.equal(interrupted?.error, "runner_restarted")
  assert.equal(requests.length, 1, "no inference call without scoped access")
  assert.deepEqual(exchanges[0], { grant, sessionId: session.id, messageId: "m1", model: "member-model", modelAccessRequired: true })
  assertNotStored(waiting.store, db.path, session.id)

  // With access again, self-resume picks it up; the turn finishes in step mode on the member's access and model.
  returnAccess = true
  assert.equal((await waiting.runner.selfResume()).resumed, 1)
  await waiting.runner.idle()
  const done = waiting.store.getTurn(session.id, "m1")
  assert.equal(done?.status, "completed", JSON.stringify(done))
  assert.equal(done?.execution, "steps")
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.apiKey, access.apiKey)
  assert.equal(requests[1]?.model, "member-model", "pinned to the turn's model, not the changed deployment default")
  waiting.store.close()

  // A step cut off with access available continues straight away, re-obtaining both credentials for the next step.
  const cut = start(() => never(), "deployment-model")
  cut.runner.send({ sessionId: session.id, messageId: "m2", prompt: "And this", model: "member-model", execution: "steps", credentials: { mcpToken: "caller-mcp", modelAccess: access, resumeGrant: grant } })
  await until(() => requests.length === 3, "the second turn's model call")
  const resumed = start(async (request) => ({ text: `Done on ${request.model}.`, toolCalls: [], usage }), "changed-deployment-model")
  await resumed.runner.idle()
  assert.equal(resumed.store.getTurn(session.id, "m2")?.status, "completed")
  const last = requests.at(-1)
  assert.equal(last?.apiKey, access.apiKey)
  assert.equal(last?.model, "member-model", "pinned to the turn's model, not the changed deployment default")
  assert.equal(exchanges.at(-1)?.messageId, "m2")
  assert.equal(tokens.at(-1)?.startsWith("fresh-mcp-"), true, "and a fresh MCP token")
  assert.ok(requests.every((request) => request.apiKey === access.apiKey), "never the deployment key")
  assertNotStored(resumed.store, db.path, session.id)
  resumed.store.close()
})
