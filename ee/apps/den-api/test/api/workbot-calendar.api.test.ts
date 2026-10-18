import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("calendar detail uses the real proxy and remains owner, organization, scope and feature guarded", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Calendar Owner"), "Calendar workspace")
  const teammate = await den.newMember(owner, orgId, "Calendar Teammate")
  const outsider = await den.createOrg(await den.signUp("Calendar Outsider"), "Another calendar workspace")
  // Arrange a persisted Automation; all observations below go through the production HTTP routes.
  const { automationRepository } = await import("../../src/automations/repository.js")
  const created = await automationRepository.create({ organizationId: orgId, ownerMemberId: owner.memberId, now: Date.now(), definition: {
    name: "Private weekly summary", instructions: "Summarize a project note", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 }, model: { providerId: "opencode", modelId: "big-pickle", variant: null }, executionTarget: "desktop", workspaceId: null,
  } })
  const path = `/v1/workbot/calendar/v1/automations/${created.automation.id}`
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const teammateToken = await den.mintMcpToken(teammate, orgId)
  const outsiderToken = await den.mintMcpToken(outsider.owner, outsider.orgId)
  assert.equal((await den.setFeature(orgId, "workbot", true)).status, 200)
  assert.equal((await den.setFeature(outsider.orgId, "workbot", true)).status, 200)
  const own = await den.request(ownerToken, "GET", path)
  assert.equal(own.status, 200, summary(own))
  assert.equal(field(own.body, "automation", "id"), created.automation.id)
  assert.equal(field(own.body, "revision", "instructions"), "Summarize a project note")
  const unavailable = await automationRepository.create({ organizationId: orgId, ownerMemberId: owner.memberId, now: Date.now(), definition: {
    name: "Earlier model summary", instructions: "Earlier project instructions", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 }, model: { providerId: "missing-provider", modelId: "missing-model", variant: null }, executionTarget: "desktop", workspaceId: null,
  } })
  const retained = await den.request(ownerToken, "GET", `/v1/workbot/calendar/v1/automations/${unavailable.automation.id}`)
  assert.equal(retained.status, 200, summary(retained))
  assert.equal(field(retained.body, "automation", "state"), "needs_attention")
  assert.equal(field(retained.body, "revision", "instructions"), "Earlier project instructions")
  for (const token of [teammateToken, outsiderToken]) {
    const denied = await den.request(token, "GET", path)
    assert.equal(denied.status, 404, summary(denied))
    assert.equal(denied.text.includes("Private weekly summary"), false)
    assert.equal(denied.text.includes("Summarize a project note"), false)
  }
  const removed = await den.as(owner, orgId)("DELETE", `/v1/members/${teammate.memberId}`)
  assert.equal(removed.status, 204, summary(removed))
  const revoked = await den.request(teammateToken, "GET", path)
  assert.ok([401, 403].includes(revoked.status), summary(revoked))
  assert.equal(revoked.text.includes("Summarize a project note"), false)
  const missing = await den.request(null, "GET", path)
  assert.equal(missing.status, 401, summary(missing))
  const writeOnly = await den.request(owner.token, "POST", "/v1/mcp/token", { orgId, body: { scopes: ["mcp:write"] } })
  assert.equal(writeOnly.status, 200, summary(writeOnly))
  const wrongScope = await den.request(text(field(writeOnly.body, "token"), "scoped token"), "GET", path)
  assert.equal(wrongScope.status, 403, summary(wrongScope))
  assert.equal(wrongScope.text.includes("Summarize a project note"), false)
  assert.equal((await den.setFeature(orgId, "workbot", false)).status, 200)
  const killed = await den.request(ownerToken, "GET", path)
  assert.equal(killed.status, 403, summary(killed))
  assert.equal(killed.text.includes("Summarize a project note"), false)
  const arbitrary = await den.request(ownerToken, "GET", `${path}/configuration`)
  assert.equal(arbitrary.status, 404, summary(arbitrary))
})
