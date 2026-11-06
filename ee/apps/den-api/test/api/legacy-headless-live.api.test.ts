/**
 * Real Den + MySQL + real Node headless runner. Workbot and Slack resolve a
 * legacy per-member provider for the executing member, not the configuring
 * owner. The default upstream is a deterministic HTTP fixture; opt into an
 * actual compatible gateway with DEN_API_TEST_GATEWAY_URL/KEY/MODEL.
 *
 * This exercises the Workbot API and Slack's runner adapter, not an external
 * Slack installation or browser/protocol sign-in.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { modelProbeFixture } from "../../../headless-runner/scripts/model-probe-fixture.js"
import { bootDen, field, list, text, type Call } from "./harness.js"

const liveUrl = process.env.DEN_API_TEST_GATEWAY_URL?.trim().replace(/\/+$/, "")
const liveKey = process.env.DEN_API_TEST_GATEWAY_KEY?.trim()
const live = Boolean(liveUrl && liveKey)
const memberKey = live ? String(liveKey) : "fixture-private-member-credential"
const ownerKey = "fixture-private-owner-credential-that-cannot-infer"
const reply = "Headless legacy route verified."
const runner = await modelProbeFixture({ protocol: "openai", modelKey: "fixture-deployment-default-must-not-be-used", answer: reply })
runner.acceptModelKey(memberKey)
const gatewayUrl = live ? String(liveUrl) : runner.providerUrl
const den = await bootDen({ env: {
  GATEWAY_ENABLED: "false",
  DEN_HEADLESS_RUNNER_URL: runner.url,
  DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32),
  DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "fixture-private-runner-callback-token-123456789",
} })

// Record only safe facts about calls, never headers or request credentials.
const realFetch = globalThis.fetch
const upstream: { model: unknown; memberKey: boolean }[] = []
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === `${gatewayUrl}/chat/completions`) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null
    upstream.push({ model: field(body, "model"), memberKey: headers.get("authorization") === `Bearer ${memberKey}` })
  }
  return realFetch(input, init)
}
after(async () => { globalThis.fetch = realFetch; await den.close(); await runner.close() })

function checked(result: Call, expected = 200): Call {
  // A successful token response legitimately contains a key. Never echo it on failure.
  assert.equal(result.status, expected, `HTTP ${result.status}; error=${String(field(result.body, "error"))}`)
  return result
}
function noKeys(value: unknown) {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes(memberKey), false, "member key leaked")
  assert.equal(serialized.includes(ownerKey), false, "owner key leaked")
}

test("Workbot and Slack use the invoking member's legacy key on the real headless runner, with no Gateway or fallback", { timeout: 180_000 }, async () => {
  const { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } = await import("../../src/headless-runner/client.js")
  const { slackRunnerForActor, slackTurnModel } = await import("../../src/slack-assistant/headless.js")
  const workspace = await den.createOrg(await den.signUp("Legacy Runtime Owner"), "Legacy headless verification")
  const owner = workspace.owner
  const member = await den.newMember(owner, workspace.orgId, "Legacy Runtime Member")
  const admin = den.as(owner, workspace.orgId)

  let modelId = process.env.DEN_API_TEST_GATEWAY_MODEL?.trim() || "fixture/model-with-slash"
  if (live && !process.env.DEN_API_TEST_GATEWAY_MODEL) {
    const models = await fetch(`${gatewayUrl}/models`, { headers: { authorization: `Bearer ${memberKey}` } })
    assert.equal(models.status, 200, "real gateway model discovery failed")
    modelId = text(list(field(await models.json(), "data"))[0]?.id, "live model id")
  }

  const created = checked(await admin("POST", "/v1/llm-providers", {
    name: "Legacy private gateway",
    source: "custom",
    customConfig: {
      id: "legacy-private-gateway", name: "Legacy private gateway", npm: "@ai-sdk/openai-compatible",
      env: ["LEGACY_PRIVATE_GATEWAY_KEY"], api: gatewayUrl,
      models: [{ id: modelId, name: "Private gateway model" }],
    },
    credentialMode: "per_member", allMembers: false, memberIds: [owner.memberId, member.memberId], teamIds: [],
  }), 201)
  const providerId = text(field(created.body, "llmProvider", "id"), "provider record id")
  const minted = checked(await admin("POST", "/v1/api-keys", { name: "Legacy gateway provisioner" }), 201)
  const provisionerKey = text(field(minted.body, "key"), "provisioner key")
  async function provision(target: string, apiKey: string) {
    const response = checked(await den.request(null, "PUT", `/v1/llm-providers/${providerId}/member-credentials/${target}`, {
      orgId: workspace.orgId, headers: { "x-api-key": provisionerKey }, body: { apiKey },
    }))
    noKeys(response.body)
  }
  await provision(owner.memberId, ownerKey)
  await provision(member.memberId, memberKey)

  const settings = checked(await admin("GET", "/v1/org/workbot-settings"))
  noKeys(settings.body)
  const selectable = list(field(settings.body, "models")).find(model => typeof model.id === "string" && model.id.includes(providerId))
  const selection = text(selectable?.id, "provider-qualified legacy model selection")
  checked(await admin("PUT", "/v1/org/workbot-settings", { model: selection }))

  const mcp = await den.mintMcpToken(member, workspace.orgId)
  const session = checked(await den.request(mcp, "GET", "/v1/workbot/session"))
  assert.equal(field(session.body, "model"), selection)
  noKeys(session.body)
  const initial = checked(await den.request(mcp, "POST", "/v1/workbot/run-token", { body: {
    model: selection, sessionId: "hs_legacy_workbot_token", messageId: "legacy-token-turn",
  } }))
  assert.equal(field(initial.body, "modelAccess", "apiKey"), memberKey)
  assert.equal(field(initial.body, "modelAccess", "model"), modelId)
  assert.equal(field(initial.body, "modelAccess", "baseUrl"), gatewayUrl)
  assert.equal(field(initial.body, "modelAccess", "protocol"), "openai")
  const grant = text(field(initial.body, "resumeGrant"), "resume grant")

  const deps = defaultHeadlessRunnerDeps(undefined, { indexKind: "workbot" })
  assert.ok(deps)
  const client = createHeadlessRunnerClient(deps)
  const conversation = await client.createSession({ title: "Legacy member Workbot proof" })
  assert.equal(conversation.ok, true)
  if (!conversation.ok) return
  const actor = { userId: member.userId, organizationId: workspace.orgId }
  const prompt = `Without using tools, reply with exactly this sentence and nothing else: ${reply}`
  const admitted = await client.sendTurn(actor, {
    sessionId: conversation.value.id, messageId: "workbot-legacy-proof", prompt, model: selection, execution: "steps",
  })
  assert.equal(admitted.ok, true)
  let workbotReply = ""
  const workbotDeadline = Date.now() + 60_000
  while (Date.now() < workbotDeadline) {
    const read = await client.readSession(conversation.value.id, { messageId: "workbot-legacy-proof" })
    assert.equal(read.ok, true)
    if (!read.ok) break
    noKeys(read.value)
    workbotReply = read.value.finalAssistantText ?? ""
    if (workbotReply.includes(reply)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(workbotReply.includes(reply), "no real Workbot runner reply")

  const selectedForSlack = await slackTurnModel({ organizationId: workspace.orgId, model: selection }, { userId: member.userId })
  assert.equal(selectedForSlack, selection)
  const slack = slackRunnerForActor(actor)
  const thread = await slack.create({ title: "Legacy member Slack proof" })
  assert.equal(thread.ok, true)
  if (!thread.ok) return
  const slackSent = await slack.send({ sessionId: thread.sessionId, messageId: "slack-legacy-proof", prompt, model: selectedForSlack })
  assert.equal(slackSent.ok, true)
  let slackReply = ""
  const slackDeadline = Date.now() + 60_000
  while (Date.now() < slackDeadline) {
    const read = await slack.read({ sessionId: thread.sessionId, messageId: "slack-legacy-proof" })
    assert.equal(read.ok, true)
    if (!read.ok) break
    noKeys(read.snapshot)
    slackReply = read.snapshot.finalAssistantText
    if (slackReply.includes(reply)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(slackReply.includes(reply), "no real Slack-adapter runner reply")
  assert.equal(upstream.length, 2, "unexpected fallback/repeated inference")
  assert.ok(upstream.every(call => call.memberKey && call.model === modelId), "wrong member key or upstream model")

  if (live) {
    // Exercise the real gateway's tool-call protocol too, not just a plain reply.
    const toolSession = await client.createSession({ title: "Legacy gateway file-tool proof" })
    assert.equal(toolSession.ok, true)
    if (!toolSession.ok) return
    const sent = await client.sendTurn(actor, {
      sessionId: toolSession.value.id, messageId: "legacy-tool-proof", model: selection, execution: "steps",
      prompt: "Use write_file to create legacy-proof.txt containing exactly 'Legacy gateway file tools verified.'. Then use read_file to read it back. Finally reply with only the text you read. Do not use any other tools.",
    })
    assert.equal(sent.ok, true)
    let trace = ""
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const read = await client.readSession(toolSession.value.id, { messageId: "legacy-tool-proof" })
      assert.equal(read.ok, true)
      if (!read.ok) break
      noKeys(read.value)
      trace = JSON.stringify(read.value.messages)
      if (read.value.finalAssistantText?.includes("Legacy gateway file tools verified.")) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.ok(trace.includes("write_file"), "the real model did not write the scratch file")
    assert.ok(trace.includes("read_file"), "the real model did not read the scratch file")
    assert.ok(trace.includes("Legacy gateway file tools verified."))
    assert.ok(upstream.every(call => call.memberKey && call.model === modelId), "tool calls used another credential or model")
  }

  // Resumes must re-resolve current credentials, not retain the old key.
  const rotated = live ? memberKey : "fixture-private-rotated-member-credential"
  if (!live) runner.acceptModelKey(rotated)
  await provision(member.memberId, rotated)
  const resumed = checked(await den.request(null, "POST", "/v1/headless/resume-token", {
    headers: { authorization: "Bearer fixture-private-runner-callback-token-123456789" },
    body: { grant, sessionId: "hs_legacy_workbot_token", messageId: "legacy-token-turn", model: selection, modelAccessRequired: true },
  }))
  assert.equal(field(resumed.body, "modelAccess", "apiKey"), rotated)

  checked(await admin("POST", `/v1/llm-providers/${providerId}/member-credentials/${member.memberId}/block`, {}))
  const beforeBlocked = upstream.length
  const blocked = await den.request(mcp, "POST", "/v1/workbot/run-token", { body: { model: selection } })
  assert.equal(blocked.status, 403)
  const resumedBlocked = await den.request(null, "POST", "/v1/headless/resume-token", {
    headers: { authorization: "Bearer fixture-private-runner-callback-token-123456789" },
    body: { grant, sessionId: "hs_legacy_workbot_token", messageId: "legacy-token-turn", model: selection, modelAccessRequired: true },
  })
  assert.notEqual(resumedBlocked.status, 200)
  const slackBlocked = await slack.send({ sessionId: thread.sessionId, messageId: "slack-blocked", prompt, model: selection })
  assert.equal(slackBlocked.ok, false)
  assert.equal(upstream.length, beforeBlocked, "blocked actor reached inference or fallback")
  noKeys(blocked.body)
  noKeys(resumedBlocked.body)

  const { cloudAgentCatalog, cloudAgentAccess } = await import("../../src/workbot/cloud-agent-model.js")
  // An active binding does not replace a current audience grant.
  await provision(member.memberId, memberKey)
  assert.equal((await cloudAgentAccess(actor, selection)).apiKey, memberKey)
  const details = checked(await admin("GET", `/v1/llm-providers/${providerId}`))
  const grantRow = list(field(details.body, "llmProvider", "access", "members")).find(entry => entry.orgMembershipId === member.memberId)
  const accessId = text(grantRow?.id, "member's provider grant")
  checked(await admin("DELETE", `/v1/llm-providers/${providerId}/access/${accessId}`), 204)
  await assert.rejects(() => cloudAgentAccess(actor, selection))
  assert.equal((await cloudAgentCatalog(actor)).models.some(model => model.id === selection), false)

  // Shared credentials need the same grant checks as per-member credentials.
  const shared = checked(await admin("POST", "/v1/llm-providers", {
    name: "Owner-only shared gateway", source: "custom",
    customConfig: { id: "owner-only-shared", name: "Owner-only shared gateway", npm: "@ai-sdk/openai-compatible", env: ["SHARED_GATEWAY_KEY"], api: gatewayUrl, models: [{ id: modelId, name: "Owner-only model" }] },
    credentialMode: "shared", apiKey: ownerKey, allMembers: false, memberIds: [owner.memberId], teamIds: [],
  }), 201)
  const sharedId = text(field(shared.body, "llmProvider", "id"), "shared provider")
  const ownerCatalog = await cloudAgentCatalog({ organizationId: workspace.orgId, userId: owner.userId })
  const sharedSelection = text(ownerCatalog.models.find(model => model.id.includes(sharedId))?.id, "owner-only shared selection")
  await assert.rejects(() => cloudAgentAccess(actor, sharedSelection))
  const memberCatalog = await cloudAgentCatalog(actor)
  noKeys(memberCatalog)
  assert.equal(memberCatalog.models.some(model => model.id.includes(sharedId)), false)
  assert.equal(upstream.length, beforeBlocked, "grant denial reached inference or fallback")
})
