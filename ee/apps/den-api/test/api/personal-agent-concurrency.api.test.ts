import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, automationDetailSchema, automationRunReceiptSchema } from "@openwork/types/automations"
import { personalAgentDetailSchema, personalAgentRunResponseSchema } from "@openwork/types/den/personal-agents"
import { bootDen, field, startFakeHttpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const turns = new Map<string, { messageId: string; model: string }>()
let held = new Set<string>()
let sessions = 0
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    response.writeHead(201).end(JSON.stringify({ id: `fixture-${++sessions}` }))
    return
  }
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "")
  if (request.method === "POST" && url.pathname.endsWith("/turns")) {
    const body: unknown = JSON.parse(raw)
    turns.set(id, { messageId: text(field(body, "messageId"), "message id"), model: text(field(body, "model"), "model") })
    response.writeHead(202).end(JSON.stringify({ state: "queued" }))
    return
  }
  const turn = turns.get(id)
  const pending = held.has(id)
  response.end(JSON.stringify({
    turns: turn ? [{ ...turn, status: pending ? "running" : "completed", error: null, usage: { inputTokens: 42, cachedInputTokens: 0, outputTokens: 3 } }] : [],
    messages: turn && !pending ? [{ role: "assistant", text: "Sweep complete.", toolCalls: [] }] : [],
    finalAssistantText: turn && !pending ? "Sweep complete." : "",
    status: pending ? "running" : "idle",
  }))
})
const den = await bootDen({ env: {
  ...gatewayFixtureEnv,
  DEN_DEPLOYMENT: "cloud",
  DEN_HEADLESS_RUNNER_URL: runner.url,
  DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters",
} })
after(async () => { await runner.close(); await den.close(); restoreCatalog() })

const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes"), "Run queue fixture")
await grantGatewayModels(den, dana, orgId, [dana])
const api = den.as(dana, orgId)
const { automationService } = await import("../../src/automations/service.js")
const { automationRepository } = await import("../../src/automations/repository.js")
const schedule = { kind: "daily", hour: 8, minute: 0, timezone: "UTC" }
const instructions = "Summarize the new reports."

async function expectStatus(request: ReturnType<typeof api>, status: number) {
  const response = await request
  assert.equal(response.status, status, summary(response))
  return response.body
}

async function until<T>(sample: () => T | Promise<T>, done: (value: T) => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await sample()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for the run")
}

test("personal-agent manual runs queue in order, without overlap or clogging claim batches", async () => {
  await expectStatus(den.setFeature(orgId, "personalAgents", true), 200)
  const agent = personalAgentDetailSchema.parse(await expectStatus(api("POST", "/v1/personal-agents", { name: "Bug watcher", brief: instructions }), 201))
  const path = `/v1/personal-agents/${agent.agent.id}`
  const { automation } = automationDetailSchema.parse(await expectStatus(api("POST", `${path}/routines`, { name: "Sweep", instructions, schedule }), 201))
  const next = () => expectStatus(api("POST", `${path}/run`), 202).then((body) => personalAgentRunResponseSchema.parse(body).run)
  const receipt = (id: string) => expectStatus(api("GET", `${path}/runs/${id}`), 200).then((body) => automationRunReceiptSchema.parse(body).run)
  const runningTurn = `fixture-${sessions + 1}`
  held = new Set([runningTurn])
  try {
    const first = await next()
    const second = await next()
    assert.equal(second.status, "queued")
    await until(() => turns.has(runningTurn), Boolean)
    assert.equal((await receipt(first.id)).status, "running")
    const queued = [second]
    for (let attempt = 0; attempt < 4; attempt += 1) queued.push(await next())
    assert.ok(queued.every((run) => run.status === "queued"))
    const queueFull = {
      error: "personal_agent_run_queue_full",
      message: "This agent already has several runs waiting. Try again when one finishes.",
    }
    assert.deepEqual(await expectStatus(api("POST", `${path}/run`), 409), queueFull)
    assert.deepEqual(await expectStatus(api("POST", `/v1/automations/${automation.id}/run`), 409), queueFull)
    const current = automationDetailSchema.parse(await expectStatus(api("GET", `/v1/automations/${automation.id}`), 200))
    assert.equal(current.automation.nextDueAt, automation.nextDueAt)
    assert.deepEqual(await automationRepository.listQueuedCloud({ limit: 1 }), [])
    for (const run of queued) assert.equal((await receipt(run.id)).startedAt, null)
    held.delete(runningTurn)
    let prior = await until(() => receipt(first.id), (run) => run.finishedAt !== null)
    for (const queuedRun of queued) {
      await automationService.tick({ batchSize: 1 })
      const run = await until(() => receipt(queuedRun.id), (candidate) => candidate.finishedAt !== null)
      assert.equal(prior.status, "succeeded")
      assert.ok(prior.finishedAt !== null && run.startedAt !== null && prior.finishedAt <= run.startedAt)
      assert.equal(run.status, "succeeded")
      prior = run
    }
  } finally {
    held.clear()
  }
})

test("a plain Cloud Automation still skips a second manual run while the first is running", async () => {
  const created = automationDetailSchema.parse(await expectStatus(api("POST", "/v1/cloud-automations", {
    name: "Routine without an agent", schedule, action: { kind: "agent", model: AUTOMATION_CLOUD_DEFAULT_MODEL, instructions },
  }), 201))
  const path = `/v1/automations/${created.automation.id}/run`
  const runningTurn = `fixture-${sessions + 1}`
  held.add(runningTurn)
  const first = await expectStatus(api("POST", path), 202)
  const runId = text(field(first, "run", "id"), "run id")
  try {
    await until(() => turns.has(runningTurn), Boolean)
    const second = await expectStatus(api("POST", path), 202)
    assert.equal(field(second, "run", "status"), "skipped")
    const current = automationDetailSchema.parse(await expectStatus(api("GET", `/v1/automations/${created.automation.id}`), 200))
    assert.equal(current.automation.nextDueAt, created.automation.nextDueAt)
  } finally {
    held.delete(runningTurn)
  }
  const receipt = await until(async () => automationRunReceiptSchema.parse(await expectStatus(api("GET", `/v1/automation-runs/${runId}`), 200)), (value) => value.run.finishedAt !== null)
  assert.equal(receipt.run.status, "succeeded")
})


test("archiving a routine cancels waiting work without starting another turn", async () => {
  const agent = personalAgentDetailSchema.parse(await expectStatus(api("POST", "/v1/personal-agents", { name: "Archive watcher", brief: instructions }), 201))
  const path = `/v1/personal-agents/${agent.agent.id}`
  const { automation } = automationDetailSchema.parse(await expectStatus(api("POST", `${path}/routines`, { name: "Sweep", instructions, schedule }), 201))
  const next = async () => personalAgentRunResponseSchema.parse(await expectStatus(api("POST", `${path}/run`), 202)).run
  const receipt = async (id: string) => automationRunReceiptSchema.parse(await expectStatus(api("GET", `${path}/runs/${id}`), 200)).run
  const runningTurn = `fixture-${sessions + 1}`
  held.add(runningTurn)
  try {
    const first = await next()
    await until(() => turns.has(runningTurn), Boolean)
    const queued = await next()
    const before = turns.size
    await expectStatus(api("DELETE", `/v1/automations/${automation.id}`), 200)
    held.delete(runningTurn)
    await until(() => receipt(first.id), (run) => run.finishedAt !== null)
    await automationService.tick({ batchSize: 5 })
    const cancelled = await until(() => receipt(queued.id), (run) => run.finishedAt !== null)
    assert.equal(cancelled.status, "cancelled")
    assert.equal(cancelled.resultSummary, "This routine was archived, so it did not run.")
    assert.equal(turns.size, before)
  } finally {
    held.clear()
  }
})
