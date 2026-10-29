import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { createApp as runnerApp } from "../../../headless-runner/src/app.js"
import { Store } from "../../../headless-runner/src/store.js"
import { nodeSqlite } from "../../../headless-runner/src/node-sqlite.js"
import { Runner } from "../../../headless-runner/src/runner.js"
import { workbotTelemetryReporter } from "../../../headless-runner/src/workbot-telemetry.js"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { TelemetryEventTable, TelemetrySessionDimensionTable } from "@openwork-ee/den-db/schema"
import { bootDen, field, startFakeOAuthMcpServer, summary, text } from "./harness.js"

const service = "workbot-telemetry-test-service-credential-000000"
const den = await bootDen({ env: { DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:8795", DEN_HEADLESS_RUNNER_TOKEN: service } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { workbotMainSession } = await import("../../src/workbot/telemetry.js")

async function events(orgId: string) {
  return db.select().from(TelemetryEventTable).where(and(eq(TelemetryEventTable.org_id, orgId), eq(TelemetryEventTable.source, "workbot")))
}

test("Workbot service facts use token identity, reject browsers and deduplicate parallel firsts without content", async () => {
  const workspace = await den.createOrg(await den.signUp("Test Owner"), "Adoption workspace")
  const teammate = await den.newMember(workspace.owner, workspace.orgId, "Test Member")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const otherToken = await den.mintMcpToken(teammate, workspace.orgId)
  const call = (body: unknown, bearer = token, credential: string | null = service) => den.request(bearer, "POST", "/v1/workbot/telemetry", {
    body, headers: credential === null ? {} : { "x-openwork-workbot-service": credential },
  })
  const signedInAt = Date.now() - 1_000
  const signIn = { event: "signed_in", id: "first-successful-login-0001", timestamp: signedInAt }
  assert.equal((await call(signIn, token, null)).status, 401)
  assert.equal((await call(signIn, token, "wrong")).status, 401)
  assert.equal((await call(signIn, "forged-token")).status, 401)
  assert.equal((await call({ ...signIn, organizationId: workspace.orgId, memberId: teammate.memberId })).status, 400)
  assert.equal((await call({ ...signIn, text: "private-message-must-never-be-stored" })).status, 400)
  const logins = await Promise.all([call(signIn), call(signIn), call(signIn), call(signIn, otherToken)])
  assert.deepEqual(logins.map((entry) => entry.status), [204, 204, 204, 204], logins.map(summary).join("\n"))
  let stored = await events(workspace.orgId)
  assert.equal(stored.length, 2)
  assert.deepEqual(new Set(stored.map((row) => row.member_id)), new Set([workspace.owner.memberId, teammate.memberId]))
  assert.equal(stored.every((row) => row.event_type === "workbot.signed_in"), true)
  assert.equal(stored.every((row) => row.event_timestamp.getTime() === signedInAt), true, "sign-in time precedes the asynchronous readiness probe/write")

  const sessionId = workbotMainSession({ organizationId: workspace.orgId, memberId: workspace.owner.memberId })
  const timestamp = Date.now()
  const accepted = { event: "accepted", sessionId, messageId: "wb_hello", timestamp, model: "test-answer-model", attachmentCount: 0, hasContext: false }
  assert.equal((await call(accepted)).status, 204)
  assert.equal((await call(accepted)).status, 204)
  const failed = { event: "failed", sessionId, messageId: "wb_hello", timestamp: timestamp + 1, attempt: timestamp, model: "test-answer-model", errorCode: "model_credentials_missing" }
  assert.equal((await call(failed)).status, 204)
  assert.equal((await call(failed)).status, 204)
  assert.equal((await call({ ...failed, timestamp: timestamp + 4, errorCode: "model_stream_private_marker_must_not_be_recorded" })).status, 204)
  assert.equal((await call({ ...failed, errorCode: "provider text includes an email@example.test" })).status, 400)
  assert.equal((await call({ ...failed, event: "completed", timestamp: timestamp + 2, errorCode: null })).status, 204)
  assert.equal((await call({ ...failed, event: "completed", timestamp: timestamp + 2, errorCode: null })).status, 204)
  assert.equal((await call({ ...failed, event: "completed", timestamp: timestamp + 5, messageId: "wb_private0001", model: "sk-private-model-marker", modelSource: "response", errorCode: null })).status, 204)
  assert.equal((await call({ ...accepted, timestamp: timestamp + 3, messageId: "wb_message0001", attachmentCount: 2, hasContext: true })).status, 204)
  assert.equal((await call({ ...accepted, timestamp: timestamp + 3, messageId: "wb_message0001", attachmentCount: 2, hasContext: true })).status, 204)
  // A greeting for another identity's deterministic conversation cannot become this person's greeting.
  assert.equal((await call({ ...accepted, sessionId: "hs_wb_" + "a".repeat(40) }, otherToken)).status, 204)
  stored = await events(workspace.orgId)
  assert.equal(stored.filter((row) => row.event_type === "workbot.greeting_started").length, 1)
  assert.equal(stored.filter((row) => row.event_type === "workbot.greeting_completed").length, 1)
  assert.equal(stored.filter((row) => row.event_type === "workbot.greeting_failed").length, 2)
  assert.equal(stored.filter((row) => row.event_type === "workbot.message_sent").length, 1)
  const dimensions = await db.select().from(TelemetrySessionDimensionTable).where(eq(TelemetrySessionDimensionTable.org_id, workspace.orgId))
  const facts = dimensions.filter((row) => row.dimension_type === "workbot")
  assert.equal(facts.find((row) => row.dimension_value === "workbot.signed_in")?.metadata?.ready_count, 0)
  assert.deepEqual(facts.find((row) => row.dimension_value === "workbot.message_sent")?.metadata, {
    attachment_count: 2, chat: "main", has_context: true, model: "test-answer-model",
  })
  const raw = JSON.stringify({ stored, dimensions })
  for (const forbidden of [workspace.owner.email, teammate.email, "private-message-must-never-be-stored", "private_marker", "sk-private-model-marker", token, service]) assert.equal(raw.includes(forbidden), false)
  assert.ok(facts.some((row) => row.metadata?.error_code === "model_stream_error"), "unrecognized provider error types become a server-owned bucket")
  const unreported = facts.find((row) => row.dimension_value === "workbot.turn_completed")
  assert.equal(unreported?.metadata?.model_source, "unknown")
  assert.equal(Object.hasOwn(unreported?.metadata ?? {}, "model"), false, "credential-like identities are omitted, not stored as model IDs")

  // Ordinary telemetry ingest must not let a signed-in client forge server Workbot outcomes or source.
  const forged = await den.as(workspace.owner, workspace.orgId)("POST", "/v1/telemetry/ingest", { events: [
    { type: "workbot.greeting_completed", timestamp: new Date().toISOString(), source: "app" },
    { type: "user.active", timestamp: new Date().toISOString(), source: "workbot" },
  ] })
  assert.equal(forged.status, 204, summary(forged))
  assert.equal((await events(workspace.orgId)).length, stored.length)

  // The ordinary admin MCP perimeter also protects the new content-free readout.
  const forbiddenReport = await den.request(token, "POST", "/mcp/admin", { headers: { accept: "application/json, text/event-stream" }, body: {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "den_workbot_adoption", arguments: {} },
  } })
  assert.equal(forbiddenReport.status, 403, summary(forbiddenReport))
  assert.equal(field(forbiddenReport.body, "error"), "admin_required")
  // Only this harness's throwaway database is changed; the product flow still gets accepted on an insert failure.
  await db.execute(sql`RENAME TABLE telemetry_event TO telemetry_event_offline`)
  try {
    assert.equal((await call({ event: "signed_in", id: "storage-failure-login-0001" })).status, 204)
  } finally {
    await db.execute(sql`RENAME TABLE telemetry_event_offline TO telemetry_event`)
  }
  const adminWorkspace = await den.createOrg(await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`), "Admin test workspace")
  const adminToken = await den.mintMcpToken(adminWorkspace.owner, adminWorkspace.orgId)
  const today = new Date().toISOString().slice(0, 10)
  const adminReport = await den.request(adminToken, "POST", "/mcp/admin", { headers: { accept: "application/json, text/event-stream" }, body: {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "den_workbot_adoption", arguments: { startDate: new Date(signedInAt).toISOString().slice(0, 10), endDate: today, organizationId: workspace.orgId } },
  } })
  assert.equal(adminReport.status, 200, summary(adminReport))
  const line = adminReport.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : adminReport.body
  assert.notEqual(field(envelope, "result", "isError"), true, adminReport.text)
  const content = field(envelope, "result", "content")
  assert.ok(Array.isArray(content))
  const report: unknown = JSON.parse(text(field(content[0], "text"), "adoption report"))
  assert.equal(field(report, "funnel", "signedIn"), 2)
  assert.equal(field(report, "funnel", "greetingCompleted"), 1)
  assert.equal(JSON.stringify(report).includes(workspace.owner.email), false)
})

test("the runner reports a completed greeting without a browser, even when sign-in readiness finishes later", async () => {
  const workspace = await den.createOrg(await den.signUp("Runner Test"), "Runner adoption workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const sessionId = workbotMainSession({ organizationId: workspace.orgId, memberId: workspace.owner.memberId })
  const directory = mkdtempSync(join(tmpdir(), "workbot-adoption-runner-"))
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  const server = serve({ fetch: den.app.fetch, hostname: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const reporter = workbotTelemetryReporter({ apiToken: service, workbotTelemetryUrl: `http://127.0.0.1:${address.port}/v1/workbot/telemetry` })
  let answeringModel = "actual-greeting-model"
  const runner = new Runner({ store, model: { complete: async () => ({ text: "private greeting response", model: answeringModel, toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }) },
    defaultModel: "requested-model-alias", defaultModelApiKey: "fake-key",
    limits: { maxConcurrentTurns: 1, maxSteps: 2, turnTimeoutMs: 30_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 }, workbotTelemetry: reporter })
  const app = runnerApp({ store, runner, apiToken: service })
  const headers = { authorization: `Bearer ${service}`, "content-type": "application/json" }
  const { recordWorkbotTelemetry, workbotTelemetrySchema } = await import("../../src/workbot/telemetry.js")
  const { readWorkbotAdoptionReport } = await import("../../src/workbot/adoption-report.js")
  const { normalizeRows } = await import("../../src/mcp/admin-tools.js")
  let finishProbe: ((count: number | null) => void) | undefined
  const delayedProbe = new Promise<number | null>((resolve) => { finishProbe = resolve })
  const signedInAt = Date.now()
  const signIn = recordWorkbotTelemetry({ organizationId: workspace.orgId, memberId: workspace.owner.memberId },
    workbotTelemetrySchema.parse({ event: "signed_in", id: "slow-readiness-signin-0001", timestamp: signedInAt }), () => delayedProbe)
  try {
    assert.equal((await app.request(`/v1/sessions/${sessionId}`, { method: "PUT", headers, body: "{}" })).status, 201)
    const send = () => app.request(`/v1/sessions/${sessionId}/turns`, { method: "POST", headers, body: JSON.stringify({ messageId: "wb_hello", prompt: "private hidden greeting prompt", credentials: { mcpToken: token, readOnly: true } }) })
    assert.equal((await send()).status, 202)
    await runner.idle()
    assert.equal((await send()).status, 202)
    await runner.idle()
    const stored = await events(workspace.orgId)
    assert.deepEqual(stored.map((row) => row.event_type).sort(), ["workbot.greeting_completed", "workbot.greeting_started"])
    const dimensions = await db.select().from(TelemetrySessionDimensionTable).where(eq(TelemetrySessionDimensionTable.org_id, workspace.orgId))
    const completed = dimensions.find((row) => row.dimension_value === "workbot.greeting_completed")
    assert.equal(completed?.metadata?.model, "actual-greeting-model")
    assert.equal(completed?.metadata?.model_source, "response")
    assert.equal(JSON.stringify({ stored, dimensions }).includes("private"), false)
    // The greeting is already terminal while the sign-in's ready-count probe is still held.
    assert.ok(finishProbe)
    finishProbe(0)
    await signIn
    const day = new Date(signedInAt).toISOString().slice(0, 10)
    const report = await readWorkbotAdoptionReport({ startDate: day, endDate: new Date().toISOString().slice(0, 10), organizationId: workspace.orgId }, async (query) => normalizeRows(await db.execute(query)))
    assert.equal(report.funnel.greetingCompleted, 1, "a slow sign-in probe cannot erase the completed greeting from its cohort")
    assert.equal(report.members.rows[0]?.greetingState, "completed")
    assert.equal(report.members.rows[0]?.readyCountAtSignIn, 0)

    // A provider reflecting most of a per-turn key must not reach either database dimension.
    answeringModel = "provider-private-ke"
    const reflected = await app.request(`/v1/sessions/${sessionId}/turns`, { method: "POST", headers, body: JSON.stringify({ messageId: "wb_message0009", prompt: "private message", credentials: { mcpToken: token, modelApiKey: "provider-private-key" } }) })
    assert.equal(reflected.status, 202)
    await runner.idle()
    assert.equal(store.getTurn(sessionId, "wb_message0009")?.status, "completed")
    const protectedDimensions = await db.select().from(TelemetrySessionDimensionTable).where(eq(TelemetrySessionDimensionTable.org_id, workspace.orgId))
    const protectedOutcome = protectedDimensions.find((row) => row.dimension_value === "workbot.turn_completed")
    assert.equal(protectedOutcome?.metadata?.model_source, "unknown")
    assert.equal(Object.hasOwn(protectedOutcome?.metadata ?? {}, "model"), false)
    for (const forbidden of [answeringModel, "provider-private-key", token, service]) assert.equal(JSON.stringify(protectedDimensions).includes(forbidden), false)
  } finally {
    finishProbe?.(0)
    await signIn
    await runner.shutdown()
    store.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test("only a completed and verified OAuth grant records a later app connection", { timeout: 30_000 }, async () => {
  const workspace = await den.createOrg(await den.signUp("Connection Test"), "Connection adoption workspace")
  const issuer = await startFakeOAuthMcpServer({ responseIssuer: true })
  try {
    const call = den.as(workspace.owner, workspace.orgId)
    const saved = await call("POST", "/v1/mcp-connections", { name: "Test notes", url: issuer.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } })
    assert.equal(saved.status, 200, summary(saved))
    const id = text(field(saved.body, "id"), "connection id")
    const start = async () => {
      const response = await call("GET", `/v1/mcp-connections/${id}/connect/start`)
      assert.equal(response.status, 200, summary(response))
      const redirect = await fetch(text(field(response.body, "authorizeUrl"), "provider URL"), { redirect: "manual" })
      return new URL(text(redirect.headers.get("location"), "callback"))
    }
    const denied = await start()
    denied.searchParams.delete("code")
    denied.searchParams.set("error", "access_denied")
    assert.equal((await den.request(null, "GET", `${denied.pathname}${denied.search}`)).status, 400)
    assert.equal((await events(workspace.orgId)).length, 0)
    const callback = await start()
    const completed = await den.request(null, "GET", `${callback.pathname}${callback.search}`)
    assert.equal(completed.status, 200, summary(completed))
    for (let attempt = 0; attempt < 50 && (await events(workspace.orgId)).length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    const stored = await events(workspace.orgId)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].event_type, "connection.connected")
    assert.match(stored[0].session_id ?? "", /^wb:oauth:[0-9a-f-]{36}$/)
    assert.equal(stored[0].member_id, workspace.owner.memberId)
    assert.equal((await den.request(null, "GET", `${callback.pathname}${callback.search}`)).status, 400)
    assert.equal((await events(workspace.orgId)).length, 1)
    const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
    assert.equal((await den.request(token, "POST", "/v1/workbot/telemetry", { headers: { "x-openwork-workbot-service": service }, body: { event: "signed_in", id: "connected-signin-test-0001" } })).status, 204)
    const dimensions = await db.select().from(TelemetrySessionDimensionTable).where(eq(TelemetrySessionDimensionTable.org_id, workspace.orgId))
    assert.equal(dimensions.find((row) => row.dimension_value === "workbot.signed_in")?.metadata?.ready_count, 1)
    const connected = dimensions.find((row) => row.dimension_value === "connection.connected")
    assert.deepEqual(connected?.metadata, { connection_id: id, app_id: "external_mcp" })
    assert.equal(JSON.stringify(dimensions).includes(callback.searchParams.get("state") ?? "not-present"), false)
  } finally { await issuer.close() }
})
