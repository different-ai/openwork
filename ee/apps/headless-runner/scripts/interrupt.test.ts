import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
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
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      if (promptOf(request) !== "Summarize my week") return { text: "Got it, just today.", toolCalls: [], usage }
      for (const word of words) {
        await sleep(40, request.signal)
        request.onText?.(word)
      }
      return { text: words.join(""), toolCalls: [], usage }
    },
  }
  using world = setup(model)
  world.runner.send({ sessionId: world.session, messageId: "first", prompt: "Summarize my week", credentials: {} })
  await sleep(130)
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
      await sleep(150, signal)
      lookups += 1
      return { output: "3:30 design review", isError: false }
    },
    async close() {},
  })
  using world = setup(model, mcp)
  world.runner.send({ sessionId: world.session, messageId: "first", prompt: "Check my calendar", credentials: { mcpToken: "token" } })
  await sleep(60)
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
  const requests: ModelRequest[] = []
  const model: ModelClient = {
    async complete(request) {
      requests.push(request)
      if (promptOf(request) === "First") {
        await sleep(200, request.signal)
        return { text: "First answer.", toolCalls: [], usage }
      }
      return { text: `Answering ${promptOf(request)}`, toolCalls: [], usage }
    },
  }
  using world = setup(model)
  world.runner.send({ sessionId: world.session, messageId: "a", prompt: "First", credentials: {} })
  await sleep(30)
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
