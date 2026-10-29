import assert from "node:assert/strict"
import { test } from "node:test"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { createHeadlessRunnerClient, type HeadlessRunnerDeps, type HeadlessModelAccess } from "../src/headless-runner/client.js"
import type { CloudAgentExecutorInput } from "../src/automations/cloud-agent-executor.js"

for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!", BETTER_AUTH_URL: "http://localhost:8790",
})) if (!process.env[name]?.trim()) process.env[name] = value

const { createSlackRunner, slackTurnModel } = await import("../src/slack-assistant/headless.js")
const { executeHeadlessAgent, headlessMessageIdForRun } = await import("../src/automations/headless-agent-executor.js")
const alias = "gateway/member-model"
const actor = { organizationId: "org_1", userId: "usr_1" }
const modelAccess: HeadlessModelAccess = { baseUrl: "https://gateway.example/v1", apiKey: "member-key", protocol: "openai" }

test("Slack resolves the invoking member's model", async () => {
  const installation = { organizationId: actor.organizationId, model: "legacy/slack" }
  const deps = {
    cloudModel: async (received: typeof actor, fallback?: string | null) => {
      assert.deepEqual(received, actor)
      assert.equal(fallback, installation.model)
      return alias
    },
  }
  assert.equal(await slackTurnModel(installation, actor, deps), alias)
  await assert.rejects(slackTurnModel(installation, actor, { cloudModel: async () => { throw new Error("denied") } }), /denied/)
  await assert.rejects(slackTurnModel(installation, actor, { cloudModel: async () => null }), /unavailable/)
})

test("Slack interruption refreshes credentials for the stored turn model", async () => {
  const models: Array<string | undefined> = []
  const runner = createSlackRunner(actor, {
    config: { url: "http://runner:8795", token: "t".repeat(40) }, maxTokenTtlMs: 3_600_000,
    mintToken: async (input) => { models.push(input.model); return { token: "member-token" } },
    fetch: async (_url, init) => init?.method === "POST"
      ? Response.json({ state: "resumed" }, { status: 202 })
      : Response.json({ turns: [{ messageId: "msg_1", status: "interrupted", model: alias, error: null }], messages: [], finalAssistantText: "" }),
  })
  assert.equal((await runner.read({ sessionId: "hs_abcdefgh", messageId: "msg_1" })).ok, true)
  assert.deepEqual(models, [alias])
})

test("Slack lost-send recovery never resolves today's inaccessible default", async () => {
  let resolved = 0
  const minted: Array<Parameters<HeadlessRunnerDeps["mintToken"]>[0]> = []
  const runner = createSlackRunner(actor, {
    config: { url: "http://runner:8795", token: "t".repeat(40) }, maxTokenTtlMs: 3_600_000,
    modelAccessRequired: async () => true,
    mintToken: async (input) => { minted.push(input); return { token: "member-token", modelAccess } },
    fetch: async (_url, init) => init?.method === "POST"
      ? Response.json({ state: "existing" }, { status: 202 })
      : Response.json({ turns: [{ messageId: "msg_1", status: "interrupted", model: alias, modelAccessRequired: true, error: null }], messages: [], finalAssistantText: "" }),
  })
  assert.equal((await runner.send({ sessionId: "hs_abcdefgh", messageId: "msg_1", prompt: "hello", resolveModel: async () => {
    resolved += 1
    throw new Error("current default is inaccessible")
  } })).ok, true)
  assert.equal(resolved, 0)
  assert.equal(minted.length, 1)
  assert.equal(minted[0]?.model, alias)
  assert.equal(minted[0]?.modelAccessRequired, true)
})

test("Slack foreground and background resumes keep the stored model with scoped access", async () => {
  const minted: Array<Parameters<HeadlessRunnerDeps["mintToken"]>[0]> = []
  const turns = [
    { messageId: "msg_1", status: "interrupted", model: alias, modelAccessRequired: true, error: null },
    { messageId: "msg_1.t1", status: "interrupted", model: alias, modelAccessRequired: true, error: null, kind: "task", parent: "msg_1" },
    { messageId: "msg_1.t1.r", status: "interrupted", model: alias, modelAccessRequired: true, error: null, kind: "report", parent: "msg_1.t1" },
  ]
  const runner = createSlackRunner(actor, {
    config: { url: "http://runner:8795", token: "t".repeat(40) }, maxTokenTtlMs: 3_600_000,
    modelAccessRequired: async () => true,
    mintToken: async (input) => { minted.push(input); return { token: "member-token", modelAccess } },
    fetch: async (_url, init) => init?.method === "POST"
      ? Response.json({ state: "existing" }, { status: 202 })
      : Response.json({ turns, messages: [], finalAssistantText: "" }),
  })
  assert.equal((await runner.read({ sessionId: "hs_abcdefgh", messageId: "msg_1" })).ok, true)
  assert.equal((await runner.background({ sessionId: "hs_abcdefgh", messageId: "msg_1" })).ok, true)
  assert.equal(minted.length, 3)
  for (const input of minted) { assert.equal(input.modelAccessRequired, true); assert.equal(input.model, alias) }
})

test("Slack new-turn selection runs only after the read proves there is no admitted turn", async () => {
  const order: string[] = []
  const runner = createSlackRunner(actor, {
    config: { url: "http://runner:8795", token: "t".repeat(40) }, maxTokenTtlMs: 3_600_000,
    mintToken: async () => { order.push("mint"); return { token: "member-token" } },
    fetch: async (_url, init) => {
      if (init?.method === "POST") return Response.json({ state: "accepted" }, { status: 202 })
      order.push("read")
      return Response.json({ turns: [], messages: [], finalAssistantText: "" })
    },
  })
  assert.equal((await runner.send({ sessionId: "hs_abcdefgh", messageId: "msg_1", prompt: "hello", resolveModel: async () => {
    order.push("select")
    return alias
  } })).ok, true)
  assert.deepEqual(order, ["read", "select", "mint"])
})

test("Slack credential refusal uses a safe non-retryable runner failure", async () => {
  const runner = createSlackRunner(actor, {
    config: { url: "http://runner:8795", token: "t".repeat(40) }, maxTokenTtlMs: 3_600_000,
    mintToken: async () => { throw new Error("private access details") },
    fetch: async () => { throw new Error("must not send") },
  })
  assert.deepEqual(await runner.send({ sessionId: "hs_abcdefgh", messageId: "msg_1", prompt: "hello", model: alias }), {
    ok: false, error: "model_access_unavailable", retryable: false,
  })
})

function automationHarness(options: { savedModel?: string; mintDenied?: boolean; scoped?: boolean; interruptAfterSend?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const minted: Array<Parameters<HeadlessRunnerDeps["mintToken"]>[0]> = []
  const messageId = headlessMessageIdForRun("run_1")
  const runner: HeadlessRunnerDeps = {
    config: { url: "http://runner:8795", token: "t".repeat(40) }, maxTokenTtlMs: 3_600_000,
    mintToken: async (input) => {
      if (options.mintDenied) throw new Error("private access details")
      assert.equal(input.model, options.savedModel ?? alias)
      minted.push(input)
      return { token: "member-token", ...(input.modelAccessRequired ? { modelAccess } : {}) }
    },
    fetch: async (url, init) => {
      if (init?.method === "POST" && String(url).endsWith("/turns")) {
        sent.push(JSON.parse(String(init.body)))
        return Response.json({ state: "accepted" }, { status: 202 })
      }
      if (init?.method === "POST") return Response.json({ id: "hs_abcdefgh" }, { status: 201 })
      const interrupted = !sent.length || (options.interruptAfterSend && sent.length === 1)
      return Response.json({ turns: [{ messageId, status: interrupted ? "interrupted" : "completed", model: options.savedModel ?? alias, error: null, ...(options.scoped ? { modelAccessRequired: true } : {}) }], messages: [], finalAssistantText: "Done." })
    },
  }
  const input: CloudAgentExecutorInput = {
    organizationId: actor.organizationId, ownerMemberId: "mem_1", automationRunId: "run_1", automationName: "Scheduled task",
    action: { kind: "agent", instructions: "Do the task", model: AUTOMATION_CLOUD_DEFAULT_MODEL }, maximumRuntimeMs: 10_000,
    previousReceipt: options.savedModel ? { runtime: "headless", sessionId: "hs_abcdefgh", messageId } : null,
    signal: new AbortController().signal, onAdmitted: async () => {},
  }
  const deps = {
    client: createHeadlessRunnerClient(runner), ownerUserId: async () => actor.userId, stillHeadless: async () => true,
    cloudModel: async () => alias,
    gatewayCatalog: async () => ({ defaultModel: alias, models: [{ id: alias, name: "Member model" }] }),
    sleep: async () => {}, pollIntervalMs: 0,
  }
  return { input, deps, sent, minted }
}

test("gateway Automations use exact actor defaults and reject unavailable explicit models without sending", async () => {
  const harness = automationHarness()
  assert.equal((await executeHeadlessAgent(harness.input, harness.deps)).ok, true)
  assert.equal(harness.sent[0]?.model, alias)
  const denied = automationHarness()
  denied.input.action.model = { providerId: "openwork", modelId: "gateway/not-assigned" }
  const result = await executeHeadlessAgent(denied.input, denied.deps)
  assert.equal(result.ok, false)
  if (!result.ok) { assert.equal(result.needsAttention, true); assert.equal(result.retryable, false) }
  assert.equal(denied.sent.length, 0)
})

test("gateway Automations keep the saved model on recovery despite a changed default", async () => {
  const harness = automationHarness({ savedModel: "gateway/original" })
  harness.deps.cloudModel = async () => { throw new Error("must not reselect") }
  assert.equal((await executeHeadlessAgent(harness.input, harness.deps)).ok, true)
  assert.equal(harness.sent[0]?.model, "gateway/original")
})

test("Automation receipt and interrupted-loop recovery retain scoped access", async () => {
  const harness = automationHarness({ savedModel: "gateway/original", scoped: true, interruptAfterSend: true })
  harness.deps.cloudModel = async () => { throw new Error("must not reselect") }
  assert.equal((await executeHeadlessAgent(harness.input, harness.deps)).ok, true)
  assert.equal(harness.minted.length, 2)
  for (const input of harness.minted) {
    assert.equal(input.model, "gateway/original")
    assert.equal(input.modelAccessRequired, true)
  }
})

test("Automation interrupted-loop recovery discovers the stored marker even without a previous receipt", async () => {
  const harness = automationHarness({ scoped: true, interruptAfterSend: true })
  const result = await executeHeadlessAgent(harness.input, harness.deps)
  assert.equal(result.ok, true)
  assert.equal(harness.minted.length, 2)
  assert.equal(harness.minted[0]?.modelAccessRequired, undefined)
  assert.equal(harness.minted[1]?.modelAccessRequired, true)
})

test("gateway credential refusal is recoverable needs-attention, not fallback or private error details", async () => {
  const harness = automationHarness({ mintDenied: true })
  const result = await executeHeadlessAgent(harness.input, harness.deps)
  assert.equal(result.ok, false)
  if (!result.ok) { assert.equal(result.needsAttention, true); assert.ok(!result.message.includes("private")) }
  assert.equal(harness.sent.length, 0)
})
