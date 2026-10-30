import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { bootDen, field, list, summary } from "./harness.js"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"

const den = await bootDen({ env: gatewayFixtureEnv })
const restoreCatalog = stubPublicModelCatalog()
after(async () => { restoreCatalog(); await den.close() })
const { db } = await import("../../src/db.js")

function step(body: unknown, id: string) {
  return list(field(body, "steps")).find((entry) => entry.id === id)
}

test("the Get set up checklist can be turned off, and when on reports each person's own steps from what actually happened", async () => {
  const workspace = await den.createOrg(await den.signUp("Avery Owner"), "Activation workspace")
  const owner = den.as(workspace.owner, workspace.orgId)
  assert.equal((await den.setFeature(workspace.orgId, "activationChecklist", false)).status, 200)

  // Off: the routes answer as if they did not exist, for Desktop and Workbot alike.
  const off = await owner("GET", "/v1/me/activation")
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")
  const ownerToken = await den.mintMcpToken(workspace.owner, workspace.orgId)
  assert.equal((await den.request(ownerToken, "GET", "/v1/workbot/activation")).status, 404)
  assert.equal(field((await den.request(ownerToken, "GET", "/v1/workbot/session")).body, "activationChecklist"), false)

  assert.equal((await den.setFeature(workspace.orgId, "activationChecklist", true)).status, 200)
  assert.equal(field((await den.request(ownerToken, "GET", "/v1/workbot/session")).body, "activationChecklist"), true)
  const before = await owner("GET", "/v1/me/activation")
  assert.equal(before.status, 200, summary(before))
  assert.deepEqual(list(field(before.body, "steps")).map((entry) => [entry.id, entry.done]), [
    ["first_response", false], ["invite_teammate", false], ["use_skill", false], ["own_provider", false], ["gateway_provider", false], ["connector", false],
  ])
  assert.equal(field(before.body, "dismissed"), false)

  // Clients report only what they alone observe; repeats and parallel tabs record one fact.
  const reports = await Promise.all([1, 2, 3].map(() => owner("POST", "/v1/me/activation/events", { step: "first_response", durationMs: 2140 })))
  assert.deepEqual(reports.map((entry) => entry.status), [200, 200, 200], reports.map(summary).join("\n"))
  assert.deepEqual(step(reports[0]?.body, "first_response"), { id: "first_response", done: true, detail: "Answered in 2.1 s" })
  const rows = await db.select().from(TelemetryEventTable).where(and(eq(TelemetryEventTable.org_id, workspace.orgId), sql`${TelemetryEventTable.event_type} like ${"activation.%"}`))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.member_id, workspace.owner.memberId)
  assert.equal(rows[0]?.source, "app")
  assert.equal((await owner("POST", "/v1/me/activation/events", { step: "connector" })).status, 400, "server-computed steps cannot be claimed by a client")
  assert.equal((await owner("POST", "/v1/me/activation/events", { step: "first_response", organizationId: workspace.orgId })).status, 400)
  // The generic telemetry ingest cannot forge a Get set up fact either.
  assert.equal((await owner("POST", "/v1/telemetry/ingest", { events: [{ type: "activation.own_provider", timestamp: new Date().toISOString(), source: "app" }] })).status, 204)
  assert.equal(step((await owner("GET", "/v1/me/activation")).body, "own_provider")?.done, false)

  // A member: the teammate exists, inviting and AI Gateway are locked with who can do them.
  const member = await den.newMember(workspace.owner, workspace.orgId, "Riley Member")
  const memberCall = den.as(member, workspace.orgId)
  const memberView = await memberCall("GET", "/v1/me/activation")
  assert.equal(memberView.status, 200, summary(memberView))
  assert.equal(step(memberView.body, "first_response")?.done, false, "the owner's first answer is not the member's")
  assert.deepEqual(step(memberView.body, "invite_teammate"), { id: "invite_teammate", done: true, detail: "2 joined, 0 invited" })
  assert.deepEqual(step(memberView.body, "gateway_provider"), { id: "gateway_provider", done: false, lockedReason: "Avery Owner manages AI Gateway" })
  const ownerView = await owner("GET", "/v1/me/activation")
  assert.deepEqual(step(ownerView.body, "invite_teammate"), { id: "invite_teammate", done: true, detail: "2 joined, 0 invited" })
  assert.equal(step(ownerView.body, "gateway_provider")?.lockedReason, undefined)

  // An admin shares a provider on AI Gateway: the step checks off for everyone in the workspace.
  const created = await owner("POST", "/v1/inference-providers", { name: "Team OpenAI", providerId: "openai", modelIds: ["gpt-6-luna"] })
  assert.equal(created.status, 201, summary(created))
  assert.deepEqual(step((await memberCall("GET", "/v1/me/activation")).body, "gateway_provider"), { id: "gateway_provider", done: true }, "members without gateway_providers.view see completion but not the provider name")
  assert.deepEqual(step((await owner("GET", "/v1/me/activation")).body, "gateway_provider"), { id: "gateway_provider", done: true, detail: "Team OpenAI on AI Gateway" })

  // Workbot reads and writes the same record with the member's Workbot token, never another person's.
  const writeOnly = await den.request(member.token, "POST", "/v1/mcp/token", { orgId: workspace.orgId, body: { scopes: ["mcp:write"] } })
  assert.equal(writeOnly.status, 200, summary(writeOnly))
  const writeOnlyToken = field(writeOnly.body, "token")
  assert.equal(typeof writeOnlyToken, "string")
  if (typeof writeOnlyToken !== "string") throw new Error("expected a write-only token")
  const denied = await den.request(writeOnlyToken, "POST", "/v1/workbot/activation/events", { body: { step: "first_response" } })
  assert.equal(denied.status, 403, summary(denied))
  assert.deepEqual(denied.body, { error: "insufficient_scope" }, "write-only grants never disclose checklist state")
  assert.equal(step((await memberCall("GET", "/v1/me/activation")).body, "first_response")?.done, false)
  const memberToken = await den.mintMcpToken(member, workspace.orgId)
  const workbotView = await den.request(memberToken, "GET", "/v1/workbot/activation")
  assert.equal(workbotView.status, 200, summary(workbotView))
  assert.deepEqual(workbotView.body, (await memberCall("GET", "/v1/me/activation")).body)
  assert.equal((await den.request("forged-token", "GET", "/v1/workbot/activation")).status, 401)
  const answered = await den.request(memberToken, "POST", "/v1/workbot/activation/events", { body: { step: "first_response" } })
  assert.equal(answered.status, 200, summary(answered))
  assert.deepEqual(step(answered.body, "first_response"), { id: "first_response", done: true })
  const hidden = await den.request(memberToken, "POST", "/v1/workbot/activation/events", { body: { step: "dismiss" } })
  assert.equal(field(hidden.body, "dismissed"), true)
  assert.equal(field((await memberCall("GET", "/v1/me/activation")).body, "dismissed"), true, "hiding in Workbot hides it in Desktop too")
  assert.equal(field((await owner("GET", "/v1/me/activation")).body, "dismissed"), false, "hiding is per person")
  const memberRows = await db.select().from(TelemetryEventTable).where(and(eq(TelemetryEventTable.member_id, member.memberId), sql`${TelemetryEventTable.event_type} like ${"activation.%"}`))
  assert.deepEqual(memberRows.map((row) => row.source).sort(), ["workbot", "workbot"])

  // Turning the feature off again hides both surfaces without losing what was recorded.
  assert.equal((await den.setFeature(workspace.orgId, "activationChecklist", false)).status, 200)
  assert.equal((await memberCall("GET", "/v1/me/activation")).status, 404)
  assert.equal((await den.request(memberToken, "POST", "/v1/workbot/activation/events", { body: { step: "dismiss" } })).status, 404)
  assert.equal((await db.select().from(TelemetryEventTable).where(sql`${TelemetryEventTable.event_type} like ${"activation.%"}`)).length, 3)
})
