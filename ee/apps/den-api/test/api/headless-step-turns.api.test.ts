/** GA saved steps and resume grants ignore legacy rollout rows. */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { bootDen, field, isRecord, summary, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

// Every turn gets its model through the member's AI Gateway access, so the owner here holds a Gateway grant.
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => { restoreFetch(); await den.close() })

const { createHeadlessRunnerClient } = await import("../../src/headless-runner/client.js")
const { slackRunnerForActor } = await import("../../src/slack-assistant/headless.js")
const { executeHeadlessAgent } = await import("../../src/automations/headless-agent-executor.js")

let orgId = ""
let otherOrgId = ""
let owner: Member
let mcpToken = ""

before(async () => {
  const created = await den.createOrg(await den.signUp("Stella Owner"), "Step turns org")
  orgId = created.orgId
  owner = created.owner
  await grantGatewayModels(den, owner, orgId, [owner])
  otherOrgId = (await den.createOrg(await den.signUp("Oscar Other"), "Other step turns org")).orgId
  const workbot = await den.setFeature(orgId, "workbot", true)
  assert.equal(workbot.status, 200, summary(workbot))
  mcpToken = await den.mintMcpToken(owner, orgId)
})

async function arrangeLegacyDurableRows(enabled: boolean) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  await client.query("INSERT INTO organization_feature (organization_id, feature_key, enabled, source) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)", [orgId, "headlessDurableTurns", enabled, "platform"])
  await client.query("INSERT INTO feature_rollout (feature_key, enabled, killed) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), killed = VALUES(killed)", ["headlessDurableTurns", enabled, !enabled])
}

/** A runner that accepts everything, records each turn's body and reports every turn completed. */
function recordingRunner() {
  const turns: Record<string, unknown>[] = []
  const runnerFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? "GET"
    if (method === "POST" && url.pathname === "/v1/sessions") return Response.json({ id: "hs_step_turns_test" }, { status: 201 })
    if (method === "POST" && url.pathname.endsWith("/turns")) {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      if (isRecord(body)) turns.push(body)
      return Response.json({ state: "accepted" }, { status: 202 })
    }
    const messageId = url.searchParams.get("messageId") ?? ""
    return Response.json({
      turns: [{ messageId, status: "completed", error: null }],
      messages: [{ role: "assistant", messageId, text: "Done.", toolCalls: [] }],
      finalAssistantText: "Done.",
    })
  }
  const deps = {
    config: { url: "http://runner", token: "r".repeat(40) },
    fetch: runnerFetch,
    mintToken: async () => ({ token: "ow_mcp_at_step_turns_test" }),
    maxTokenTtlMs: 3_600_000,
  }
  return { deps, client: createHeadlessRunnerClient(deps), turns }
}

test("legacy disabled rows and kill switches cannot disable GA steps or resume grants", async () => {
  const session = () => den.request(mcpToken, "GET", "/v1/workbot/session")
  let turn = 0
  const runToken = () => {
    turn += 1
    return den.request(mcpToken, "POST", "/v1/workbot/run-token", { body: { sessionId: `hs_durable_turns_test_${turn}`, messageId: `msg-${turn}` } })
  }
  await arrangeLegacyDurableRows(false)
  const off = await session()
  assert.equal(off.status, 200, summary(off))
  assert.equal(field(off.body, "stepTurns"), true)
  const offToken = await runToken()
  assert.equal(offToken.status, 200, summary(offToken))
  assert.equal(typeof field(offToken.body, "resumeGrant"), "string", "legacy disabled row cannot stop grants")

  await arrangeLegacyDurableRows(true)
  const on = await session()
  assert.equal(on.status, 200, summary(on))
  assert.equal(field(on.body, "stepTurns"), true)
  const onToken = await runToken()
  assert.equal(onToken.status, 200, summary(onToken))
  assert.equal(typeof field(onToken.body, "resumeGrant"), "string", "legacy enabled rows also preserve GA grants")

  await arrangeLegacyDurableRows(false)
  assert.equal(field((await session()).body, "stepTurns"), true, "legacy disabled row is ignored")
  assert.equal(typeof field((await runToken()).body, "resumeGrant"), "string", "grants stay enabled")
})

test("Slack's runner always sends steps, ignoring legacy disabled rows", async () => {
  const runner = recordingRunner()
  const slack = slackRunnerForActor({ userId: owner.userId, organizationId: orgId }, runner.deps)

  await arrangeLegacyDurableRows(false)
  const off = await slack.send({ sessionId: "hs_slack_step_turns", messageId: "msg_slack_off", prompt: "hello" })
  assert.equal(off.ok, true)
  assert.equal(runner.turns[0]?.execution, "steps")

  await arrangeLegacyDurableRows(true)
  const on = await slack.send({ sessionId: "hs_slack_step_turns", messageId: "msg_slack_on", prompt: "hello" })
  assert.equal(on.ok, true)
  assert.equal(runner.turns[1]?.execution, "steps")

  const elsewhere = recordingRunner()
  await slackRunnerForActor({ userId: owner.userId, organizationId: otherOrgId }, elsewhere.deps)
    .send({ sessionId: "hs_slack_step_turns", messageId: "msg_slack_other", prompt: "hello" })
  assert.equal(elsewhere.turns[0]?.execution, "steps", "also enabled with no stored rollout")
  await arrangeLegacyDurableRows(false)
})

test("the Automations executor always sends steps, ignoring legacy disabled rows", async () => {
  const run = async (runId: string) => {
    const runner = recordingRunner()
    const result = await executeHeadlessAgent({
      organizationId: orgId,
      ownerMemberId: owner.memberId,
      automationRunId: runId,
      automationName: "Step turns",
      action: { kind: "agent", instructions: "Say done.", model: AUTOMATION_CLOUD_DEFAULT_MODEL },
      maximumRuntimeMs: 60_000,
      previousReceipt: null,
      signal: new AbortController().signal,
      onAdmitted: async () => {},
    }, {
      client: runner.client,
      ownerUserId: async () => owner.userId,
      stillHeadless: async () => true,
      sleep: async () => {},
      pollIntervalMs: 0,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(runner.turns.length, 1)
    return runner.turns[0] ?? {}
  }

  await arrangeLegacyDurableRows(false)
  assert.equal((await run("run_step_turns_off")).execution, "steps")
  await arrangeLegacyDurableRows(true)
  assert.equal((await run("run_step_turns_on")).execution, "steps")
  await arrangeLegacyDurableRows(false)
})
