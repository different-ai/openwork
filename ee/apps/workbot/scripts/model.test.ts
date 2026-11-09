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
function fakeRunner(catalog?: { defaultModel: string; models: { id: string; name: string }[]; verified?: boolean }, mintToken = async (): Promise<{ token: string; modelAttribution?: { organizationId: string; memberId: string; userId: string } }> => ({ token: "mcp-token" })) {
  const turns: Record<string, unknown>[] = []
  const sessions: Record<string, unknown>[] = []
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
    if (method === "PUT") {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (isRecord(body)) sessions.push(body)
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
  return { client, turns, sessions }
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
    const runner = fakeRunner(undefined, () => den.runToken("member-access-token"))
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

test("workbotDriveFiles reaches the instructions of the main chat and side chats, and only when Den turns it on", async () => {
  const instructionsOf = async (driveFiles?: boolean) => {
    const runner = fakeRunner()
    const deps: WorkbotDeps = { client: runner.client, canSchedule: async () => false, ...(driveFiles === undefined ? {} : { driveFiles: async () => driveFiles }) }
    await sendWorkbotMessage(actor, { id: "message_one", text: "hi" }, deps)
    await sendWorkbotMessage(actor, { id: "message_two", text: "in a side chat", chat: "sidechat000000001" }, deps)
    return runner.sessions.flatMap((session) => typeof session.instructions === "string" ? [session.instructions] : [])
  }
  const on = await instructionsOf(true)
  assert.ok(on.length >= 2)
  for (const instructions of on) assert.ok(instructions.includes("createGoogleDriveDownloadLink"))
  for (const instructions of [...await instructionsOf(false), ...await instructionsOf()]) assert.equal(instructions.includes("createGoogleDriveDownloadLink"), false)
  // A Den from before the feature doesn't say: off.
  const older = {
    user: { id: "user_test", name: null, email: "person@example.test" },
    organization: { id: "org_test", name: "Test Org", brandAppName: null },
    memberId: "member_test",
    enabled: true,
    canSchedule: false,
  }
  assert.equal(denSessionSchema.parse(older).driveFiles, false)
  assert.equal(denSessionSchema.parse({ ...older, driveFiles: true }).driveFiles, true)
  assert.equal(denSessionSchema.parse(older).quickReply, false)
  assert.equal(denSessionSchema.parse({ ...older, quickReply: true }).quickReply, true)
})

test("quickReply reaches main and side-chat instructions only when enabled", async () => {
  for (const quickReply of [undefined, false, true]) {
    const runner = fakeRunner()
    const deps: WorkbotDeps = { client: runner.client, canSchedule: async () => false, ...(quickReply === undefined ? {} : { quickReply: async () => quickReply }) }
    await sendWorkbotMessage(actor, { id: "message_one", text: "hi" }, deps)
    await sendWorkbotMessage(actor, { id: "message_two", text: "in a side chat", chat: "sidechat000000001" }, deps)
    const instructions = runner.sessions.flatMap(session => typeof session.instructions === "string" ? [session.instructions] : [])
    assert.ok(instructions.length >= 2)
    for (const prompt of instructions) assert.equal(prompt.includes("before any tool call, including search_capabilities"), quickReply === true)
  }
})
