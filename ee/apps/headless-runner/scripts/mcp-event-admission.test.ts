import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient, HEADLESS_MAX_PROMPT_CHARS } from "@openwork-ee/headless-protocol"
import { createApp } from "../src/app.js"
import type { ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const apiToken = "fixture-runner-token-at-least-thirty-two-characters"

test("an event turn queues behind the current answer and retrying its id does not answer twice", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  const requests: ModelRequest[] = []
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const runner = new Runner({ store, defaultModel: "fixture-model", defaultModelApiKey: "fixture-key",
    limits: { maxConcurrentTurns: 2, maxSteps: 3, turnTimeoutMs: 5000, credentialRefreshMs: Infinity, contextCharBudget: 100_000 },
    model: { complete: async (request) => {
      requests.push(request)
      if (requests.length === 1) { started.resolve(); await release.promise }
      return { text: "Finished", toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }
    } },
  })
  try {
    const session = store.createSession({ owner: "fixture-owner" })
    const app = createApp({ store, runner, apiToken })
    const client = createHeadlessRunnerClient({ config: { url: "https://runner.example.test", token: apiToken, owner: session.owner ?? undefined },
      fetch: (url, init) => app.request(new Request(url, init)), maxTokenTtlMs: 60_000,
      mintToken: async () => ({ token: "fixture-mcp-token" }),
    })
    const actor = { organizationId: "org", userId: "user" }
    assert.equal((await client.sendTurn(actor, { sessionId: session.id, messageId: "wb_user_message", prompt: "Answer my question" })).ok, true)
    await started.promise
    const input = { sessionId: session.id, messageId: `wb_event_${"A".repeat(43)}`, prompt: "An MCP event arrived. Summarize this change.", execution: "steps" as const }
    assert.equal((await client.sendTurn(actor, input)).ok, true)
    assert.equal(store.getTurn(session.id, input.messageId)?.status, "queued")
    assert.equal(store.getTurn(session.id, "wb_user_message")?.status, "running")
    assert.equal(requests[0].signal?.aborted, false)
    assert.equal((await client.sendTurn(actor, input)).ok, true)
    release.resolve()
    await runner.idle()
    assert.equal(store.getTurn(session.id, "wb_user_message")?.status, "completed")
    assert.equal(store.getTurn(session.id, input.messageId)?.status, "completed")
    assert.equal(store.getTurn(session.id, input.messageId)?.execution, "steps")
    assert.equal(requests.length, 2)
    assert.ok(requests[1].messages.some((message) => message.role === "user" && message.text.includes(input.prompt)))
    assert.ok(requests[1].messages.some((message) => message.role === "assistant" && message.text === "Finished"), "event sees the previous answer")
    assert.equal((await client.sendTurn(actor, input)).ok, true)
    await runner.idle()
    assert.equal(requests.length, 2)
    const oversized = await client.sendTurn(actor, { ...input, messageId: "wb_oversized_event", prompt: "x".repeat(HEADLESS_MAX_PROMPT_CHARS + 1) })
    assert.equal(oversized.ok, false)
    if (!oversized.ok) assert.equal(oversized.status, 400)
    assert.equal(store.getTurn(session.id, "wb_oversized_event"), null)
  } finally {
    release.resolve()
    await runner.shutdown()
    store.close()
  }
})
