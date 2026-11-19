import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { WORKBOT_CHAT_ID, workbotOwner, workbotPersonKey, workbotSessionId, workbotSideChatSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createApp } from "../src/app.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const token = "runner-service-token-0123456789-0123456789"

test("server-only Workbot routing preserves the existing person, owner, main chat and side chat identities", () => {
  assert.equal(workbotPersonKey("org", "member"), "b8cf098498849346ab0f4796d2e0fff379fd4d50")
  assert.equal(workbotOwner("org", "member"), "wb:b8cf098498849346ab0f4796d2e0fff379fd4d50")
  assert.equal(workbotSessionId("org", "member"), "hs_wb_b8cf098498849346ab0f4796d2e0fff379fd4d50")
  assert.equal(workbotSideChatSessionId("org", "member", "0123456789abcdef"), "hs_wbs_51e6a5c64504100f1e372764fbd2829bb3fb968c")
  assert.notEqual(workbotOwner("org", "another"), workbotOwner("org", "member"))
  assert.notEqual(workbotOwner("another", "member"), workbotOwner("org", "member"))
  assert.equal(WORKBOT_CHAT_ID.test("0123456789abcdef"), true)
  assert.equal(WORKBOT_CHAT_ID.test("invalid/chat"), false)
})

test("Node session reads fence scoped-marker proof by exact expectedOwner even when the owner header is forged", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  try {
    const owner = workbotOwner("org", "member")
    const other = workbotOwner("org", "another")
    const session = store.createSession({ owner })
    store.admitTurn({ sessionId: session.id, messageId: "original", prompt: "private prompt", model: "original-model", modelAccessRequired: true })
    store.setTurnStatus(session.id, "original", "interrupted", "runner_restarted")
    const runner = new Runner({ store, model: { complete: async () => { throw new Error("reads must never infer") } }, defaultModel: "unused",
      limits: { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 1000, credentialRefreshMs: 1000, contextCharBudget: 1000 },
    })
    const app = createApp({ store, runner, apiToken: token })
    const read = (expectedOwner?: string, routedOwner = owner) => {
      const query = new URLSearchParams({ messageId: "original", outputs: "none", limit: "1" })
      if (expectedOwner !== undefined) query.set("expectedOwner", expectedOwner)
      return app.request(`/v1/sessions/${session.id}?${query}`, { headers: { authorization: `Bearer ${token}`, "x-openwork-headless-owner": routedOwner } })
    }
    const mismatch = await read(other, other)
    assert.equal(mismatch.status, 404)
    assert.deepEqual(await mismatch.json(), { error: "unknown_session" })
    assert.equal((await read(`${owner} `)).status, 404, "owner comparison is exact")
    assert.equal((await read("")).status, 400, "an empty explicit fence is invalid, not unscoped")
    const allowed = await read(owner, other)
    assert.equal(allowed.status, 200, "the explicit owner fence, not the ignored Node routing header, proves ownership")
    const snapshot = z.object({ turns: z.array(z.object({ model: z.string(), modelAccessRequired: z.boolean() })) }).parse(await allowed.json())
    assert.deepEqual(snapshot.turns, [{ model: "original-model", modelAccessRequired: true }])
    assert.equal((await read()).status, 200, "the new query remains optional for existing trusted callers")
  } finally {
    store.close()
  }
})

test("typed readSession forwards an optional owner fence and keeps the scoped policy marker", async () => {
  const queries: URLSearchParams[] = []
  const owner = workbotOwner("org", "member")
  const client = createHeadlessRunnerClient({ config: { url: "https://runner.example.test", token, owner }, maxTokenTtlMs: 1000,
    mintToken: async () => { throw new Error("a proof read must not mint") },
    fetch: async (url) => {
      queries.push(new URL(String(url)).searchParams)
      return Response.json({ turns: [{ messageId: "original", model: "original-model", modelAccessRequired: true, status: "interrupted", error: "runner_restarted" }], messages: [], finalAssistantText: "" })
    },
  })
  const read = await client.readSession("hs_12345678", { expectedOwner: owner, messageId: "original", outputs: "none", limit: 1 })
  assert.ok(read.ok)
  assert.equal(read.value.turns[0].modelAccessRequired, true)
  assert.equal(queries[0].get("expectedOwner"), owner)
  assert.equal(queries[0].get("messageId"), "original")
  await client.readSession("hs_12345678")
  assert.equal(queries[1].has("expectedOwner"), false)
})
