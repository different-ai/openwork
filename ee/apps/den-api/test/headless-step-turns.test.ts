/**
 * Step-by-step headless turns (saved steps), without a database: the protocol client sends
 * `execution: "steps"` only when given. Slack and Automations default to saved steps, with dependency injection
 * for compatibility tests. The GA wiring is covered with a real
 * database in test/api/headless-step-turns.api.test.ts.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { createHeadlessRunnerClient, type HeadlessModelAccess } from "../../../packages/headless-protocol/src/client.ts"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const { createSlackRunner } = await import("../src/slack-assistant/headless.ts")
const { executeHeadlessAgent } = await import("../src/automations/headless-agent-executor.ts")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const modelAccess: HeadlessModelAccess = { baseUrl: "https://gateway.example/v1", apiKey: "member-key", protocol: "openai" }
const alias = "gateway/member-model"

/**
 * A runner that accepts everything and records each turn's body. A turn it hasn't been sent yet doesn't exist; a sent
 * one reads as completed on the model it was sent with. `gateway`: Den mints scoped model access with every token.
 */
function recordingRunner(options: { gateway?: boolean } = {}) {
  const turns: Record<string, unknown>[] = []
  const runnerFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? "GET"
    if (method === "POST" && url.pathname === "/v1/sessions") return Response.json({ id: "hs_step_turns_unit" }, { status: 201 })
    if (method === "POST" && url.pathname.endsWith("/turns")) {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (isRecord(body)) turns.push(body)
      return Response.json({ state: "accepted" }, { status: 202 })
    }
    const messageId = url.searchParams.get("messageId") ?? ""
    const sent = turns.find((turn) => turn.messageId === messageId)
    if (!sent) return Response.json({ turns: [], messages: [], finalAssistantText: "" })
    return Response.json({
      turns: [{ messageId, status: "completed", error: null, ...(typeof sent.model === "string" ? { model: sent.model } : {}), ...(options.gateway ? { modelAccessRequired: true } : {}) }],
      messages: [{ role: "assistant", messageId, text: "Done.", toolCalls: [] }],
      finalAssistantText: "Done.",
    })
  }
  const deps = {
    config: { url: "http://runner", token: "r".repeat(40) },
    fetch: runnerFetch,
    mintToken: async () => ({ token: "ow_mcp_at_unit", ...(options.gateway ? { modelAccess } : {}) }),
    ...(options.gateway ? { modelAccessRequired: async () => true } : {}),
    maxTokenTtlMs: 3_600_000,
  }
  return { deps, client: createHeadlessRunnerClient(deps), turns }
}

const actor = { userId: "usr_1", organizationId: "org_1" }

test("sendTurn sends execution only when given", async () => {
  const runner = recordingRunner()
  await runner.client.sendTurn(actor, { sessionId: "hs_1", messageId: "msg_1", prompt: "hello" })
  await runner.client.sendTurn(actor, { sessionId: "hs_1", messageId: "msg_2", prompt: "hello", execution: undefined })
  await runner.client.sendTurn(actor, { sessionId: "hs_1", messageId: "msg_3", prompt: "hello", execution: "steps" })
  assert.equal(runner.turns.length, 3)
  assert.equal("execution" in (runner.turns[0] ?? {}), false, "absent: body exactly as before")
  assert.equal("execution" in (runner.turns[1] ?? {}), false, "undefined: no field")
  assert.equal(runner.turns[2]?.execution, "steps")
  assert.deepEqual(Object.keys(runner.turns[0] ?? {}).sort(), ["credentials", "messageId", "prompt"])
})

test("Slack defaults to GA step mode and retains protocol test injection", async () => {
  const cases: Array<{ name: string; stepTurns?: () => Promise<boolean>; expected: "steps" | undefined }> = [
    { name: "GA default", expected: "steps" },
    { name: "off", stepTurns: async () => false, expected: undefined },
    { name: "check fails", stepTurns: async () => { throw new Error("den_unreachable") }, expected: undefined },
    { name: "on", stepTurns: async () => true, expected: "steps" },
  ]
  for (const entry of cases) {
    const runner = recordingRunner()
    const slack = createSlackRunner(actor, runner.deps, entry.stepTurns ? { stepTurns: entry.stepTurns } : {})
    const sent = await slack.send({ sessionId: "hs_slack", messageId: "msg_slack", prompt: "hello" })
    assert.equal(sent.ok, true, entry.name)
    assert.equal(runner.turns[0]?.execution, entry.expected, entry.name)
    if (entry.expected === undefined) assert.equal("execution" in (runner.turns[0] ?? {}), false, entry.name)
  }
})

test("the Automations executor retains protocol test injection", async () => {
  const cases: Array<{ name: string; stepTurns: (organizationId: string) => Promise<boolean>; expected: "steps" | undefined }> = [
    { name: "off", stepTurns: async () => false, expected: undefined },
    { name: "check fails", stepTurns: async () => { throw new Error("den_unreachable") }, expected: undefined },
    { name: "on", stepTurns: async (organizationId) => organizationId === "org_1", expected: "steps" },
  ]
  for (const entry of cases) {
    const runner = recordingRunner()
    const result = await executeHeadlessAgent({
      organizationId: "org_1",
      ownerMemberId: "mem_1",
      automationRunId: `run_${entry.name.replaceAll(" ", "_")}`,
      automationName: "Step turns",
      action: { kind: "agent", instructions: "Say done.", model: AUTOMATION_CLOUD_DEFAULT_MODEL },
      maximumRuntimeMs: 60_000,
      previousReceipt: null,
      signal: new AbortController().signal,
      onAdmitted: async () => {},
    }, {
      client: runner.client,
      ownerUserId: async () => "usr_1",
      stillHeadless: async () => true,
      cloudModel: async () => alias,
      gatewayCatalog: async () => ({ defaultModel: alias, models: [{ id: alias, name: "Member model" }] }),
      stepTurns: entry.stepTurns,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(result.ok, true, `${entry.name}: ${JSON.stringify(result)}`)
    assert.equal(runner.turns.length, 1, entry.name)
    assert.equal(runner.turns[0]?.execution, entry.expected, entry.name)
    if (entry.expected === undefined) assert.equal("execution" in (runner.turns[0] ?? {}), false, entry.name)
  }
})

test("with the AI Gateway on, step mode and scoped model access travel together", async () => {
  // Protocol client: both on one send.
  const direct = recordingRunner({ gateway: true })
  const sent = await direct.client.sendTurn(actor, { sessionId: "hs_1", messageId: "msg_both", prompt: "hello", model: alias, execution: "steps" })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(direct.turns[0]?.execution, "steps")
  assert.deepEqual(field(direct.turns[0], "credentials", "modelAccess"), modelAccess)

  // Slack: the member's resolved model with scoped access, and injected execution mode.
  for (const stepTurns of [false, true]) {
    const runner = recordingRunner({ gateway: true })
    const slack = createSlackRunner(actor, runner.deps, { stepTurns: async () => stepTurns })
    const result = await slack.send({ sessionId: "hs_slack", messageId: "msg_slack", prompt: "hello", resolveModel: async () => alias })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(runner.turns[0]?.model, alias)
    assert.deepEqual(field(runner.turns[0], "credentials", "modelAccess"), modelAccess)
    assert.equal(runner.turns[0]?.execution, stepTurns ? "steps" : undefined)
  }

  // Automations: the owner's Gateway model with scoped access, and injected execution mode.
  for (const stepTurns of [false, true]) {
    const runner = recordingRunner({ gateway: true })
    const result = await executeHeadlessAgent({
      organizationId: "org_1",
      ownerMemberId: "mem_1",
      automationRunId: `run_gateway_${stepTurns}`,
      automationName: "Step turns",
      action: { kind: "agent", instructions: "Say done.", model: AUTOMATION_CLOUD_DEFAULT_MODEL },
      maximumRuntimeMs: 60_000,
      previousReceipt: null,
      signal: new AbortController().signal,
      onAdmitted: async () => {},
    }, {
      client: runner.client,
      ownerUserId: async () => "usr_1",
      stillHeadless: async () => true,
      cloudModel: async () => alias,
      gatewayCatalog: async () => ({ defaultModel: alias, models: [{ id: alias, name: "Member model" }] }),
      stepTurns: async () => stepTurns,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(runner.turns[0]?.model, alias)
    assert.deepEqual(field(runner.turns[0], "credentials", "modelAccess"), modelAccess)
    assert.equal(runner.turns[0]?.execution, stepTurns ? "steps" : undefined)
  }
})

function field(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) current = isRecord(current) ? current[key] : undefined
  return current
}
