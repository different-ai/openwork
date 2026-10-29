import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import {
  editWorkbotMessage,
  readWorkbotThread,
  retryWorkbotMessage,
  sendWorkbotMessage,
  startWorkbotGreeting,
  type WorkbotActor,
  type WorkbotDeps,
} from "@openwork-ee/workbot-server"
import { denSessionSchema } from "../src/server/den.js"

const actor: WorkbotActor = {
  organizationId: "org_test",
  organizationName: "Test Org",
  organizationMetadata: {},
  memberId: "member_test",
  userId: "user_test",
  firstName: "Test",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A runner that accepts everything and records the body of every turn it is sent. */
function fakeRunner(catalog?: { defaultModel: string; models: { id: string; name: string }[]; verified?: boolean }) {
  const turns: Record<string, unknown>[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const runnerFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? "GET"
    if (url.pathname === "/v1/models" && catalog) return json(200, catalog)
    if (method === "POST" && url.pathname.endsWith("/turns")) {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (isRecord(body)) turns.push(body)
      return json(202, { state: "accepted" })
    }
    if (method === "PUT") return json(200, { id: decodeURIComponent(url.pathname.split("/").at(-1) ?? "") })
    if (method === "DELETE") return json(200, { removed: [] })
    if (method === "GET" && url.searchParams.get("messageId")) {
      // A failed message, for the retry.
      const messageId = url.searchParams.get("messageId") ?? ""
      return json(200, {
        turns: [{ messageId, status: "failed", error: "model_http_500" }],
        messages: [{ role: "user", messageId, text: "hello again" }],
        finalAssistantText: "",
      })
    }
    // No conversation yet: the greeting starts it.
    return json(404, { error: "unknown_session" })
  }
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "t".repeat(32) },
    fetch: runnerFetch,
    mintToken: async () => ({ token: "mcp-token" }),
    maxTokenTtlMs: 60_000,
  })
  return { client, turns }
}

async function sendEveryKind(deps: WorkbotDeps) {
  await startWorkbotGreeting(actor, {}, deps)
  await sendWorkbotMessage(actor, { id: "message_one", text: "hi" }, deps)
  await sendWorkbotMessage(actor, { id: "message_two", text: "in a side chat", chat: "sidechat000000001" }, deps)
  await retryWorkbotMessage(actor, { id: "message_one" }, deps)
  await editWorkbotMessage(actor, { id: "message_one", newId: "message_three", text: "edited" }, deps)
}

test("every turn Workbot sends carries the organization's default model", async () => {
  const runner = fakeRunner()
  const asked: string[] = []
  await sendEveryKind({
    client: runner.client,
    canSchedule: async () => false,
    model: async (organizationId) => {
      asked.push(organizationId)
      return "gateway/model-a"
    },
  })
  assert.equal(runner.turns.length, 5)
  for (const turn of runner.turns) assert.equal(turn.model, "gateway/model-a", `turn ${String(turn.messageId)} has the model`)
  assert.ok(asked.every((id) => id === "org_test"))
})

test("without a default model, turns leave the model to the runner", async () => {
  for (const model of [undefined, async () => null, async (): Promise<string | null> => { throw new Error("den_unreachable") }]) {
    const runner = fakeRunner()
    await sendEveryKind({ client: runner.client, canSchedule: async () => false, ...(model ? { model } : {}) })
    assert.equal(runner.turns.length, 5)
    for (const turn of runner.turns) assert.equal("model" in turn, false)
  }
})

test("a Den from before the default model reads as the runner's default", () => {
  const base = {
    user: { id: "user_test", name: null, email: "person@example.test" },
    organization: { id: "org_test", name: "Test Org", brandAppName: null },
    memberId: "member_test",
    enabled: true,
    canSchedule: false,
    sideChats: false,
  }
  assert.equal(denSessionSchema.parse(base).model, null)
  assert.equal(denSessionSchema.parse({ ...base, model: "gateway/model-a" }).model, "gateway/model-a")
  assert.equal(denSessionSchema.parse(base).verifyModel, false)
})

const verifiedCatalog = { defaultModel: "gateway/other", models: [{ id: "gateway/luna", name: "GPT-6 Luna" }, { id: "gateway/custom", name: "Custom model" }], verified: true }

test("the explicit rollout verifies Luna and an organization override on every new turn", async () => {
  for (const model of ["gateway/luna", "gateway/custom"]) {
    const runner = fakeRunner(verifiedCatalog)
    await sendEveryKind({ client: runner.client, canSchedule: async () => false, model: async () => model, verifyModel: true })
    assert.equal(runner.turns.length, 5)
    for (const turn of runner.turns) assert.equal(turn.model, model)
  }
})

test("unavailable, old, unreachable and unverified catalogs cannot send on another model", async () => {
  for (const catalog of [undefined, { ...verifiedCatalog, verified: false }, { ...verifiedCatalog, models: [] }, { defaultModel: verifiedCatalog.defaultModel, models: verifiedCatalog.models }]) {
    const runner = fakeRunner(catalog)
    const deps: WorkbotDeps = { client: runner.client, canSchedule: async () => false, model: async () => "gateway/luna", verifyModel: true }
    await assert.rejects(sendWorkbotMessage(actor, { id: "message_001", text: "Hello" }, deps), { code: "workbot_model_unavailable" })
    await assert.rejects(startWorkbotGreeting(actor, {}, deps), { code: "workbot_model_unavailable" })
    assert.equal(runner.turns.length, 0)
    // Killing only the new rollout restores the earlier send behavior without removing the conversation.
    await sendWorkbotMessage(actor, { id: "message_002", text: "Hello" }, { ...deps, verifyModel: false })
    assert.equal(runner.turns.length, 1)
    assert.equal(runner.turns[0]?.model, "gateway/luna")
  }
})

test("turns run step by step only when Den says stepTurns (saved step turns)", async () => {
  for (const stepTurns of [undefined, false]) {
    const runner = fakeRunner()
    await sendEveryKind({ client: runner.client, canSchedule: async () => false, ...(stepTurns === undefined ? {} : { stepTurns }) })
    assert.equal(runner.turns.length, 5)
    for (const turn of runner.turns) assert.equal("execution" in turn, false, `turn ${String(turn.messageId)} is sent as before`)
  }
  const runner = fakeRunner()
  await sendEveryKind({ client: runner.client, canSchedule: async () => false, stepTurns: true })
  assert.equal(runner.turns.length, 5)
  for (const turn of runner.turns) assert.equal(turn.execution, "steps", `turn ${String(turn.messageId)} runs step by step`)
})

test("a Den from before step turns reads as off", () => {
  const base = {
    user: { id: "user_test", name: null, email: "person@example.test" },
    organization: { id: "org_test", name: "Test Org", brandAppName: null },
    memberId: "member_test",
    enabled: true,
    canSchedule: false,
  }
  assert.equal(denSessionSchema.parse(base).stepTurns, false)
  assert.equal(denSessionSchema.parse({ ...base, stepTurns: true }).stepTurns, true)
})

test("resuming an interrupted turn carries step mode only with stepTurns", async () => {
  for (const stepTurns of [false, true]) {
    const turns: Record<string, unknown>[] = []
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    const runnerFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (init?.method === "POST" && url.pathname.endsWith("/turns")) {
        const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}")
        if (isRecord(body)) turns.push(body)
        return json(202, { state: "accepted" })
      }
      if (url.pathname === "/v1/files/status") return json(200, { enabled: false })
      return json(200, { turns: [{ messageId: "wb_message_one", status: "interrupted", error: null }], messages: [], finalAssistantText: "" })
    }
    const client = createHeadlessRunnerClient({ config: { url: "http://runner", token: "t".repeat(32) }, fetch: runnerFetch, mintToken: async () => ({ token: "mcp-token" }), maxTokenTtlMs: 60_000 })
    await readWorkbotThread(actor, {}, { client, canSchedule: async () => false, stepTurns })
    assert.equal(turns.length, 1)
    assert.equal(turns[0]?.prompt, "resume")
    assert.equal(turns[0]?.execution, stepTurns ? "steps" : undefined)
  }
})
