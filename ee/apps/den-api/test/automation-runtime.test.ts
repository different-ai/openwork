import assert from "node:assert/strict"
import { after, test, type TestContext } from "node:test"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import type { CloudAgentExecutorInput } from "../src/automations/cloud-agent-executor.js"

import { bootDen } from "./api/harness.js"

const den = await bootDen()
after(() => den.close())
await den.signUp("Executor fixture")
const { executeHeadlessAgent } = await import("../src/automations/headless-agent-executor.js")
const HOUR = 3_600_000
const messageIds: string[] = []

function fixture(t: TestContext, ticks: number[], statuses: string[]) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let aborted = 0
  let polls = 0
  let mints = 0
  let messageId = ""
  const ttls: number[] = []
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "synthetic-runner-token" },
    maxTokenTtlMs: HOUR,
    mintToken: async ({ ttlMs }) => { mints += 1; ttls.push(ttlMs ?? 0); return { token: `synthetic-token-${mints}` } },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === "/v1/sessions") return Response.json({ id: "runtime-session" }, { status: 201 })
      if (url.pathname.endsWith("/turns")) {
        assert.equal(typeof init?.body, "string")
        if (typeof init?.body !== "string") throw new Error("Expected a turn body")
        const body: unknown = JSON.parse(init.body)
        if (!body || typeof body !== "object" || !("messageId" in body) || typeof body.messageId !== "string") throw new Error("Expected message id")
        messageId = body.messageId
        messageIds.push(messageId)
        return Response.json({ state: "queued" }, { status: 202 })
      }
      if (url.pathname.endsWith("/abort")) { aborted += 1; return Response.json({ accepted: true }) }
      const status = aborted ? "aborted" : statuses[polls++] ?? "running"
      return Response.json({ turns: [{ messageId, status, model: "fixture", error: null }], messages: [], finalAssistantText: "Completed.", status: "idle" })
    },
  })
  const input: CloudAgentExecutorInput = {
    organizationId: "org_fixture", ownerMemberId: "om_fixture", automationRunId: "atr_fixture", automationName: "Report",
    action: { kind: "agent", instructions: "Prepare a report.", model: { providerId: "fixture", modelId: "fixture" } },
    maximumRuntimeMs: HOUR, previousReceipt: null, signal: new AbortController().signal, onAdmitted: async () => {},
  }
  let sleeps = 0
  const run = () => executeHeadlessAgent(input, {
    client, ownerUserId: async () => "usr_fixture", stillHeadless: async () => true,
    cloudModel: async () => "fixture", gatewayCatalog: async () => ({ defaultModel: "fixture", models: [{ id: "fixture", name: "Fixture", provider: "fixture" }], verified: true }),
    stepTurns: async () => true, pollIntervalMs: 1,
    sleep: async (_ms, signal) => { t.mock.timers.tick(ticks[sleeps++] ?? HOUR); signal.throwIfAborted() },
  })
  return { run, input, ttls, aborted: () => aborted, sleeps: () => sleeps, mints: () => mints }
}

test("the headless executor continues past 15 minutes, refreshes credentials, and stops at exactly one hour", async (t) => {
  messageIds.length = 0
  const runtime = fixture(t, [900_001, 2_099_999, 599_999, 1], ["running", "interrupted", "running"])
  const result = await runtime.run()
  assert.equal(result.ok, false)
  if (result.ok) throw new Error("Expected the one-hour deadline")
  assert.equal(result.code, "execution_timed_out")
  assert.equal(result.status, "failed")
  assert.equal(runtime.sleeps(), 4, "no earlier whole-run deadline cuts off useful work")
  assert.equal(runtime.aborted(), 1)
  assert.equal(runtime.mints(), 2, "an interrupted credential stretch gets fresh credentials")
  assert.deepEqual(runtime.ttls, [HOUR, HOUR], "credential TTL is still capped at one hour")
  assert.equal(messageIds.length, 2)
  assert.equal(messageIds[0], messageIds[1], "credential renewal resumes the same turn rather than repeating work")
})

test("a saved one-hour budget can finish normally after 20 minutes", async (t) => {
  const runtime = fixture(t, [1_200_000], ["completed"])
  const result = await runtime.run()
  assert.equal(result.ok, true)
  assert.equal(runtime.aborted(), 0)
})

test("the existing 15-minute budget is still enforced when no one changes it", async (t) => {
  const runtime = fixture(t, [900_000], ["running"])
  runtime.input.maximumRuntimeMs = 900_000
  const result = await runtime.run()
  assert.equal(result.ok, false)
  if (result.ok) throw new Error("Expected the saved deadline")
  assert.equal(result.code, "execution_timed_out")
  assert.equal(runtime.aborted(), 1)
})
