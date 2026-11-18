/**
 * Tenant isolation: a member of organization A cannot read or change
 * organization B's analytics, connections or audit history, and an org-A
 * credential sent with org B's header still acts in org A. Ported from
 * evals/core/org-model-analytics.e2e.test.ts and the two-org parts of
 * evals/specs/audit-api-coverage.test.ts.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { bootDen, field, list, startFakeMcpServer, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
const service = await startFakeMcpServer({ tools: [{ name: "team_status", description: "Status", text: "ok" }] })
after(async () => {
  await service.close()
  await den.close()
})

let orgA = ""
let orgB = ""
let ownerA: Member
let ownerB: Member

before(async () => {
  const a = await den.createOrg(await den.signUp("Olivia Alpha"), "Alpha org")
  orgA = a.orgId
  ownerA = a.owner
  const b = await den.createOrg(await den.signUp("Bo Beta"), "Beta org")
  orgB = b.orgId
  ownerB = b.owner
})

function modelEvent(sessionId: string, type: "session.active" | "task.started", model: string) {
  return {
    type, timestamp: new Date().toISOString(), source: "app", sessionId,
    dimensions: [{ type: "model", value: model, label: model }, { type: "model_selection", value: "default", label: "default" }],
  }
}

test("one organization's model analytics never reach another, and an outsider can neither read nor write them", async () => {
  const sent = await den.as(ownerA, orgA)("POST", "/v1/telemetry/ingest", {
    events: [modelEvent("alpha-session", "session.active", "prov/alpha-model"), modelEvent("alpha-session", "task.started", "prov/alpha-model")],
  })
  assert.equal(sent.status, 204, summary(sent))

  const alpha = await den.as(ownerA, orgA)("GET", "/v1/telemetry/analytics")
  assert.equal(alpha.status, 200, summary(alpha))
  assert.deepEqual(field(alpha.body, "models", "usage30d"), [{ id: "prov/alpha-model", label: "prov/alpha-model", sessions: 1 }])

  const beta = await den.as(ownerB, orgB)("GET", "/v1/telemetry/analytics")
  assert.equal(beta.status, 200, summary(beta))
  assert.deepEqual(field(beta.body, "models", "usage30d"), [])
  assert.equal(beta.text.includes("prov/alpha-model"), false)

  // Bo names org A in the header: refused for reads and writes.
  const peek = await den.as(ownerB, orgA)("GET", "/v1/telemetry/analytics")
  assert.equal(peek.status, 404, summary(peek))
  assert.equal(peek.text.includes("prov/alpha-model"), false)
  const inject = await den.as(ownerB, orgA)("POST", "/v1/telemetry/ingest", { events: [modelEvent("intruder", "session.active", "prov/intruder-model")] })
  assert.equal(inject.status, 404, summary(inject))
  const after = await den.as(ownerA, orgA)("GET", "/v1/telemetry/analytics")
  assert.deepEqual(field(after.body, "models", "usage30d"), [{ id: "prov/alpha-model", label: "prov/alpha-model", sessions: 1 }])
})

test("an outsider cannot read, change or remove another organization's connection, whichever organization header they send", async () => {
  const created = await den.as(ownerA, orgA)("POST", "/v1/mcp-connections", { name: "Alpha status", url: `${service.url}/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: true } })
  assert.equal(created.status, 200, summary(created))
  const id = text(field(created.body, "id"), "connection id")

  for (const scope of [orgA, orgB]) {
    const bo = den.as(ownerB, scope)
    const read = await bo("GET", `/v1/mcp-connections/${id}`)
    assert.equal(read.status, 404, `read with ${scope === orgA ? "A" : "B"} header: ${summary(read)}`)
    const listed = await bo("GET", "/v1/mcp-connections?scope=manageable")
    assert.equal(listed.text.includes(id), false)
    const edit = await bo("PATCH", `/v1/mcp-connections/${id}`, { name: "Hijacked" })
    assert.equal(edit.status, 404, `edit: ${summary(edit)}`)
    const key = await bo("PUT", `/v1/mcp-connections/${id}/my-credential`, { apiKey: "intruder-key" })
    assert.equal(key.status, 404, `save key: ${summary(key)}`)
    const removed = await bo("DELETE", `/v1/mcp-connections/${id}`)
    assert.equal(removed.status, 404, `delete: ${summary(removed)}`)
  }

  const still = await den.as(ownerA, orgA)("GET", `/v1/mcp-connections/${id}`)
  assert.equal(still.status, 200, summary(still))
  assert.equal(field(still.body, "name"), "Alpha status")
})

test("an outsider sees none of another organization's audit history", async () => {
  const teamA = await den.createTeam(ownerA, orgA, "Alpha audited", [])
  await den.createTeam(ownerB, orgB, "Beta audited", [])

  const listA = await den.as(ownerA, orgA)("GET", "/v1/audit/operations?limit=100")
  assert.equal(listA.status, 200, summary(listA))
  const opsA = list(field(listA.body, "operations")).map((op) => String(op.id))
  assert.ok(opsA.length > 0, "org A has history")

  const readA = await den.as(ownerB, orgA)("GET", "/v1/audit/operations?limit=100")
  assert.equal(readA.status, 404, summary(readA))
  assert.equal(readA.text.includes(teamA), false)

  const listB = await den.as(ownerB, orgB)("GET", "/v1/audit/operations?limit=100")
  assert.equal(listB.status, 200, summary(listB))
  const opsB = list(field(listB.body, "operations")).map((op) => String(op.id))
  assert.ok(opsB.length > 0, "org B has its own history")
  assert.deepEqual(opsB.filter((id) => opsA.includes(id)), [])
  assert.equal(listB.text.includes(orgA), false)
  assert.equal(listB.text.includes(teamA), false)

  const foreign = await den.as(ownerB, orgB)("GET", `/v1/audit/operations/${opsA[0]}/events`)
  assert.equal(foreign.status, 404, summary(foreign))
})

test("an org-A API key sent with org B's organization header still acts in org A", async () => {
  const minted = await den.as(ownerA, orgA)("POST", "/v1/api-keys", { name: "Alpha key" })
  assert.equal(minted.status, 201, summary(minted))
  const apiKey = text(field(minted.body, "key"), "api key value")

  const teamName = `Key header mismatch ${den.stamp}`
  const crossed = await den.request(null, "POST", "/v1/teams", { headers: { "x-api-key": apiKey, "x-openwork-org-id": orgB }, body: { name: teamName } })

  assert.equal(crossed.status, 201, summary(crossed))
  assert.equal(field(crossed.body, "team", "organizationId"), orgA)
  const teamsB = await den.as(ownerB, orgB)("GET", "/v1/org")
  assert.equal(teamsB.text.includes(teamName), false, "the team must never land in org B")
  const teamsA = await den.as(ownerA, orgA)("GET", "/v1/org")
  assert.equal(teamsA.text.includes(teamName), true, "the team belongs to the key's organization")
})

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

/** Org A's owner connects an identity provider and issues its SCIM token, as the dashboard does. */
async function scimTokenForOrgA(): Promise<{ bearer: string; domain: string }> {
  const domain = `alpha-${den.stamp}.test`
  const saml = await den.as(ownerA, orgA)("POST", "/v1/sso/saml", {
    issuer: `http://127.0.0.1/idp/alpha-${den.stamp}`,
    domain,
    entryPoint: `https://login.example.test/alpha-${den.stamp}/saml2`,
    cert: "idp-test-signing-certificate",
    audience: "http://127.0.0.1:8790",
  })
  assert.equal(saml.status, 201, summary(saml))
  await den.arrangeSsoConnectionEnabled(orgA)
  const issued = await den.as(ownerA, orgA)("POST", "/v1/scim/token")
  assert.equal(issued.status, 201, summary(issued))
  return { bearer: text(field(issued.body, "scimToken"), "SCIM token"), domain }
}

function scim(bearer: string, method: "POST" | "PATCH" | "DELETE", pathname: string, body?: unknown) {
  return den.request(null, method, `/api/auth/scim/v2${pathname}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/scim+json, application/json", "content-type": "application/scim+json" },
    rawBody: body === undefined ? undefined : JSON.stringify(body),
  })
}

function scimCreate(bearer: string, email: string, externalId: string) {
  return scim(bearer, "POST", "/Users", {
    schemas: [SCIM_USER_SCHEMA], userName: email, name: { givenName: "Ada", familyName: "Alpha" },
    emails: [{ primary: true, value: email, type: "work" }], externalId, active: true,
  })
}

const deactivate = { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: "replace", value: { active: false } }] }

test("an organization's SCIM token cannot delete or deactivate people who are not its users", async () => {
  const { bearer, domain } = await scimTokenForOrgA()
  const stranger = await den.signUp("Sam Stranger")

  // Someone with no tie to org A, and a member of org B only: neither id is org A's to act on.
  for (const userId of [stranger.userId, ownerB.userId]) {
    const deleted = await scim(bearer, "DELETE", `/Users/${userId}`)
    assert.equal(deleted.status, 404, summary(deleted))
    const deactivated = await scim(bearer, "PATCH", `/Users/${userId}`, deactivate)
    assert.equal(deactivated.status, 404, summary(deactivated))
  }
  assert.equal((await den.signIn(stranger.email)).status, 200, "the stranger's account still exists")
  assert.equal((await den.signIn(ownerB.email)).status, 200, "org B's owner still exists")
  const rosterB = await den.as(ownerB, orgB)("GET", "/v1/org")
  assert.equal(rosterB.status, 200, summary(rosterB))
  assert.equal(list(field(rosterB.body, "members")).some((entry) => field(entry, "user", "email") === ownerB.email), true)

  // A member who joined org A by invitation loses org A, not their account.
  const invited = await den.newMember(ownerA, orgA, "Ivy Invited")
  const removed = await scim(bearer, "DELETE", `/Users/${invited.userId}`)
  assert.equal(removed.status, 204, summary(removed))
  const rosterA = await den.as(ownerA, orgA)("GET", "/v1/org")
  assert.equal(list(field(rosterA.body, "members")).some((entry) => field(entry, "user", "email") === invited.email), false, "removed from org A")
  assert.equal((await den.signIn(invited.email)).status, 200, "the invited person keeps their own account")

  // The user the identity provider created is still deprovisioned in full, and a repeat stays quiet.
  const email = `ada@${domain}`
  const created = await scimCreate(bearer, email, "idp-ada")
  assert.equal(created.status, 201, summary(created))
  const provisionedId = text(field(created.body, "id"), "SCIM user id")
  const deprovisioned = await scim(bearer, "DELETE", `/Users/${provisionedId}`)
  assert.equal(deprovisioned.status, 204, summary(deprovisioned))
  assert.equal((await scim(bearer, "DELETE", `/Users/${provisionedId}`)).status, 204, "deleting again is not an error")
  const afterA = await den.as(ownerA, orgA)("GET", "/v1/org")
  assert.equal(list(field(afterA.body, "members")).some((entry) => field(entry, "user", "email") === email), false)
  const again = await scimCreate(bearer, email, "idp-ada")
  assert.equal(again.status, 201, summary(again))
  assert.notEqual(field(again.body, "id"), provisionedId, "the deprovisioned account was deleted, so this is a new one")
})
