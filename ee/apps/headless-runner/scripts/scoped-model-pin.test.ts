import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createHeadlessRunnerClient, type HeadlessModelAccess } from "@openwork-ee/headless-protocol"

const actor = { userId: "member", organizationId: "org" }
const originalAccess: HeadlessModelAccess = { baseUrl: "https://original.example.test/v1", apiKey: "original-member-key", protocol: "anthropic" }
const changedAccess: HeadlessModelAccess = { baseUrl: "https://changed.example.test/v1", apiKey: "changed-member-key", protocol: "openai-responses" }
const config = { url: "https://runner.example.test", token: "runner-token" }
const input = { sessionId: "hs_12345678", messageId: "original", prompt: "Resume this", readOnly: true }
const snapshot = (model: string | null = "original-model") => ({
  // Family entries are not the original turn and must never choose its route.
  turns: [{ messageId: "task", model: "task-model", status: "interrupted", error: null }, { messageId: input.messageId, model, status: "interrupted", error: "runner_restarted" }],
  messages: [], finalAssistantText: "",
})
const sendSchema = z.object({ model: z.string().optional(), credentials: z.object({ mcpToken: z.string(), readOnly: z.boolean().optional(), resumeGrant: z.string().optional(), modelAccess: z.unknown().optional() }) })

for (const requested of [undefined, "changed-model", "original-model"]) {
  test(`scoped preflight pins ${requested ?? "an omitted model"} before minting even when the new default is inaccessible`, async () => {
    const order: string[] = []
    let sent: unknown
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000,
      modelAccessRequired: (member) => { assert.deepEqual(member, actor); return true },
      mintToken: async (selection) => {
        order.push(`mint:${selection.model}`)
        // A default-first implementation would throw here before discovering the still-authorized original model.
        assert.equal(selection.model, "original-model", "the changed/implicit default must never be minted")
        assert.equal(selection.readOnly, true)
        assert.equal(selection.sessionId, input.sessionId)
        assert.equal(selection.messageId, input.messageId)
        return { token: "original-mcp", resumeGrant: "original-grant", modelAccess: originalAccess }
      },
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          order.push("read")
          const query = new URL(String(url)).searchParams
          assert.equal(query.get("messageId"), input.messageId)
          assert.equal(query.get("limit"), "1")
          assert.equal(query.get("outputs"), "none")
          return Response.json(snapshot())
        }
        order.push("send")
        sent = JSON.parse(String(init?.body))
        return Response.json({ state: "resumed" }, { status: 202 })
      },
    })
    assert.deepEqual(await client.sendTurn(actor, { ...input, ...(requested ? { model: requested } : {}) }), { ok: true, value: { state: "resumed" } })
    assert.deepEqual(order, ["read", "mint:original-model", "send"])
    const body = sendSchema.parse(sent)
    assert.equal(body.model, "original-model")
    assert.deepEqual(body.credentials, { mcpToken: "original-mcp", readOnly: true, resumeGrant: "original-grant", modelAccess: originalAccess })
  })
}

test("persisted scoped markers survive the public snapshot and force original-model minting after rollout off", async () => {
  for (const rolloutOn of [true, false]) {
    const order: string[] = []
    let sent = false
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000,
      modelAccessRequired: () => rolloutOn,
      mintToken: async (selection) => {
        order.push("mint")
        assert.equal(selection.modelAccessRequired, true)
        assert.equal(selection.model, "original-model")
        return { token: "original-mcp", modelAccess: originalAccess }
      },
      fetch: async (_url, init) => {
        if (init?.method === "GET") {
          order.push("read")
          const state = snapshot()
          return Response.json({ ...state, turns: state.turns.map((turn) => ({ ...turn, modelAccessRequired: true })) })
        }
        sent = true
        const body = sendSchema.parse(JSON.parse(String(init?.body)))
        assert.equal(body.model, "original-model")
        assert.deepEqual(body.credentials.modelAccess, originalAccess)
        return Response.json({ state: "resumed" }, { status: 202 })
      },
    })
    // With the rollout off, the caller echoes the nonsecret marker obtained in its original read.
    const result = await client.sendTurn(actor, { ...input, ...(!rolloutOn ? { modelAccessRequired: true } : {}) })
    assert.equal(result.ok, true)
    assert.equal(sent, true)
    assert.deepEqual(order, ["read", "mint"])
    const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 1, outputs: "none" })
    assert.ok(read.ok)
    assert.equal(read.value.turns.find((turn) => turn.messageId === input.messageId)?.modelAccessRequired, true)
  }
})

test("scoped snapshot outages, malformed responses and lost scoped credentials never dispatch or fall back", async () => {
  for (const mode of ["unreachable", "unavailable", "malformed", "lost-access"]) {
    let minted = 0
    let sent = 0
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000,
      modelAccessRequired: async () => true,
      mintToken: async () => { minted += 1; return { token: "mcp" } },
      fetch: async (_url, init) => {
        if (init?.method !== "GET") { sent += 1; return Response.json({ state: "accepted" }, { status: 202 }) }
        if (mode === "unreachable") throw new Error("private network detail")
        if (mode === "unavailable") return Response.json({ error: "internal_error" }, { status: 503 })
        if (mode === "malformed") return Response.json({ unexpected: true })
        return Response.json(snapshot())
      },
    })
    const result = await client.sendTurn(actor, input)
    assert.equal(result.ok, false, mode)
    assert.equal(sent, 0, mode)
    assert.equal(minted, mode === "lost-access" ? 1 : 0, "a failed preflight never attempts today's default")
  }
})

test("rollout off-to-on cannot convert interrupted legacy null-model work to today's scoped default", async () => {
  for (const required of [true, false]) {
    let minted = 0
    let sent = 0
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000,
      modelAccessRequired: () => required,
      mintToken: async () => { minted += 1; return { token: "mcp", modelAccess: changedAccess } },
      fetch: async (_url, init) => {
        if (init?.method === "GET") return Response.json(snapshot(null))
        sent += 1
        return Response.json({ state: "accepted" }, { status: 202 })
      },
    })
    assert.deepEqual(await client.sendTurn(actor, { ...input, model: "changed-model" }), { ok: false, status: 409, error: "headless_saved_model_unavailable" })
    assert.equal(sent, 0)
    assert.equal(minted, required ? 0 : 1)
  }
})

test("new scoped turns retain their requested selection; missing sessions use normal send handling", async () => {
  for (const exists of [true, false]) {
    const models: Array<string | undefined> = []
    let sent = 0
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000,
      modelAccessRequired: () => true,
      mintToken: async ({ model }) => { models.push(model); return { token: "mcp", modelAccess: changedAccess } },
      fetch: async (_url, init) => {
        if (init?.method === "GET") return exists ? Response.json({ turns: [], messages: [], finalAssistantText: "" }) : Response.json({ error: "unknown_session" }, { status: 404 })
        sent += 1
        assert.equal(sendSchema.parse(JSON.parse(String(init?.body))).model, "changed-model")
        return exists ? Response.json({ state: "accepted" }, { status: 202 }) : Response.json({ error: "unknown_session" }, { status: 404 })
      },
    })
    const result = await client.sendTurn(actor, { ...input, model: "changed-model" })
    assert.equal(result.ok, exists)
    assert.equal(sent, 1)
    assert.deepEqual(models, ["changed-model"])
  }
})

test("legacy sends without the scoped hook, or with it false, introduce no read roundtrip", async () => {
  for (const hook of [undefined, () => false]) {
    const methods: Array<string | undefined> = []
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000, modelAccessRequired: hook,
      mintToken: async () => ({ token: "legacy-mcp" }),
      fetch: async (_url, init) => { methods.push(init?.method); return Response.json({ state: "accepted" }, { status: 202 }) },
    })
    assert.equal((await client.sendTurn(actor, input)).ok, true)
    assert.deepEqual(methods, ["POST"])
  }
})

test("scoped callers without a preflight hook re-mint the original route and fail closed if it disappears", async () => {
  for (const losesAccess of [false, true]) {
    const selected: Array<string | undefined> = []
    const order: string[] = []
    let sent = 0
    const client = createHeadlessRunnerClient({ config, maxTokenTtlMs: 1000,
      mintToken: async ({ model }) => {
        selected.push(model)
        order.push(`mint:${model}`)
        return { token: model === "original-model" ? "original-mcp" : "changed-mcp", ...(model === "original-model" ? losesAccess ? {} : { modelAccess: originalAccess } : { modelAccess: changedAccess }) }
      },
      fetch: async (_url, init) => {
        if (init?.method === "GET") { order.push("read"); return Response.json(snapshot()) }
        order.push("send")
        sent += 1
        const body = sendSchema.parse(JSON.parse(String(init?.body)))
        assert.equal(body.model, "original-model")
        assert.deepEqual(body.credentials.modelAccess, originalAccess)
        assert.equal(body.credentials.mcpToken, "original-mcp")
        return Response.json({ state: "resumed" }, { status: 202 })
      },
    })
    assert.equal((await client.sendTurn(actor, { ...input, model: "changed-model" })).ok, !losesAccess)
    assert.deepEqual(selected, ["changed-model", "original-model"])
    assert.deepEqual(order, ["mint:changed-model", "read", "mint:original-model", ...(!losesAccess ? ["send"] : [])])
    assert.equal(sent, losesAccess ? 0 : 1)
  }
})
