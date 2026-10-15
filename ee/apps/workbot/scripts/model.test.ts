import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import {
  editWorkbotMessage,
  retryWorkbotMessage,
  sendWorkbotMessage,
  startWorkbotGreeting,
  type WorkbotActor,
  type WorkbotDeps,
} from "@openwork-ee/workbot-server"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { createServer } from "node:http"
import { once } from "node:events"

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
function fakeRunner(mintToken = async () => ({ token: "mcp-token" })) {
  const turns: Record<string, unknown>[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const runnerFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? "GET"
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
    mintToken,
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

test("Workbot forwards only Den-issued attribution for greetings, side chats, sends, edits and retries, and drops it after rollout off", async () => {
  const modelAttribution = { memberId: "mem_authenticated", userId: "usr_authenticated", organizationId: "org_authenticated", email: "member@example.test" }
  let enabled = true
  let issued = 0
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/workbot/run-token")
    assert.equal(request.headers.authorization, "Bearer member-access-token")
    let body = ""
    for await (const chunk of request) body += chunk
    assert.equal(body.includes("modelAttribution"), false, "identity is never submitted as caller input")
    issued++
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ token: "mcp-token", ...(enabled ? { modelAttribution } : {}) }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    const den = createDen({ apiUrl: `http://127.0.0.1:${address.port}`, publicUrl: "https://workbot.example.test" })
    const runner = fakeRunner(() => den.runToken("member-access-token"))
    await sendEveryKind({ client: runner.client, canSchedule: async () => false, model: async () => "selected-alias" })
    assert.equal(issued, 5)
    for (const turn of runner.turns) {
      assert.ok(isRecord(turn.credentials))
      assert.equal(turn.credentials.mcpToken, "mcp-token")
      assert.deepEqual(turn.credentials.modelAttribution, modelAttribution)
    }
    assert.ok(isRecord(runner.turns[0].credentials) && runner.turns[0].credentials.readOnly === true, "the greeting stays read-only")
    enabled = false
    const before = runner.turns.length
    await sendEveryKind({ client: runner.client, canSchedule: async () => false })
    assert.equal(issued, 10)
    for (const turn of runner.turns.slice(before)) {
      assert.ok(isRecord(turn.credentials))
      assert.equal(turn.credentials.mcpToken, "mcp-token")
      assert.equal("modelAttribution" in turn.credentials, false)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
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
})
