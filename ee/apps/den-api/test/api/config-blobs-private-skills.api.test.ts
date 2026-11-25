import assert from "node:assert/strict"
import { after, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

const den = await bootDen({ env: { DEN_PLAN_GATING_ENABLED: "true" } })
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("An isolated MySQL test database is required")
const mysql = client
const dayMs = 24 * 60 * 60 * 1000
const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const { provisionSsoMembership } = await import("../../src/identity-provisioning.js")

function expectStatus(call: Call, code: number) {
  assert.equal(call.status, code, summary(call))
  return call.body
}

async function settle(api: ReturnType<typeof den.as>, id: string) {
  for (let i = 0; i < 30; i++) {
    await runConfigBlobWorkerOnce()
    const body = expectStatus(await api("GET", `/v1/config-blobs/change-requests/${id}`), 200)
    const state = field(body, "changeRequest", "status")
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(String(state))) return body
  }
  throw new Error("Config request did not settle")
}

test("Config moves a private skill and its file to a member joining later, without duplicates", async (t) => {
  const source = await den.createOrg(await den.signUp("Source Admin"), "Source workspace")
  const target = await den.createOrg(await den.signUp("Target Admin"), "Target workspace")
  const creator = await den.newMember(source.owner, source.orgId, "Skill Creator")
  const peer = await den.newMember(target.owner, target.orgId, "Destination Peer")
  const a = den.as(source.owner, source.orgId)
  const b = den.as(target.owner, target.orgId)
  const name = `private-config-${den.stamp}`
  const contents = "Read the synthetic field report."
  const guide = "Synthetic supporting file."
  expectStatus(await den.as(creator, source.orgId)("POST", "/v1/plugins", { name, components: [{ type: "skill", input: {
    rawSourceText: `---\nname: ${name}\ndescription: Summarize field notes.\n---\n\n${contents}`,
    normalizedPayloadJson: { files: [{ path: "references/guide.md", text: guide }] },
  } }] }), 201)
  const whole = expectStatus(await a("GET", "/v1/config-blobs/export"), 200)
  assert.equal(list(field(whole, "areas", "plugins", "skills", "items")).filter((item) => item.name === name).length, 1)
  const blob = expectStatus(await a("GET", "/v1/config-blobs/export?areas=members.people,plugins.skills,plugins.plugins"), 200)
  const skills = list(field(blob, "areas", "plugins", "skills", "items"))
  const plugins = list(field(blob, "areas", "plugins", "plugins", "items"))
  assert.equal(skills.filter((item) => item.name === name).length, 1)
  assert.equal(plugins.filter((item) => item.name === name).length, 1)
  const skillsOnly = expectStatus(await a("GET", "/v1/config-blobs/export?areas=plugins.skills"), 200)
  assert.equal(list(field(skillsOnly, "areas", "plugins", "skills", "items")).filter((item) => item.name === name).length, 1)
  assert.equal(field(skillsOnly, "areas", "plugins", "plugins"), undefined)

  async function importConfig() {
    const submitted = expectStatus(await b("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge" }), 202)
    const id = text(field(submitted, "changeRequest", "id"), "request id")
    const analyzed = await settle(b, id)
    assert.equal(field(analyzed, "changeRequest", "status"), "needs_review", JSON.stringify(analyzed))
    const plan = expectStatus(await b("GET", `/v1/config-blobs/change-requests/${id}/plan`), 200)
    assert.equal(field(plan, "plan", "summary", "blocking"), 0, JSON.stringify(plan))
    const planHash = text(field(plan, "plan", "planHash"), "plan hash")
    expectStatus(await b("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash }), 200)
    const applied = await settle(b, id)
    assert.equal(field(applied, "changeRequest", "status"), "applied", JSON.stringify(applied))
  }
  await importConfig()

  const orgId = normalizeDenTypeId("organization", target.orgId)
  const userId = normalizeDenTypeId("user", creator.userId)
  const [pending] = await mysql.execute("SELECT i.id, m.id AS member_id, TIMESTAMPDIFF(SECOND, i.created_at, i.expires_at) AS lifetime FROM invitation i JOIN member m ON m.invite_id = i.id WHERE i.organization_id = ? AND i.email = ?", [orgId, creator.email])
  const [placeholder] = list(pending)
  assert.ok(placeholder)
  assert.ok(Math.abs(Number(placeholder.lifetime) * 1000 - 90 * dayMs) < 2_000)
  const sentAt = Date.now()
  const ordinary = expectStatus(await b("POST", "/v1/invitations", { email: `ordinary-${den.stamp}@example.test`, role: "member" }), 201)
  const ordinaryExpiry = Date.parse(text(field(ordinary, "expiresAt"), "standard invitation expiry"))
  assert.ok(Math.abs(ordinaryExpiry - sentAt - 7 * dayMs) < 2_000)
  await mysql.execute("UPDATE invitation SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 DAY) WHERE id = ?", [placeholder.id])
  assert.equal(await provisionSsoMembership({ organizationId: orgId, userId, email: creator.email }), "invitation_required")
  await mysql.execute("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.plan', JSON_OBJECT('tier', 'team')) WHERE id = ?", [orgId])
  assert.equal(await provisionSsoMembership({ organizationId: orgId, userId, email: creator.email }), "joined_by_invitation")
  const [joined] = await mysql.execute("SELECT id FROM member WHERE organization_id = ? AND user_id = ?", [orgId, userId])
  assert.deepEqual(joined, [{ id: placeholder.member_id }])
  const creatorToken = await den.mintMcpToken(creator, target.orgId)
  const adminToken = await den.mintMcpToken(target.owner, target.orgId)
  const peerToken = await den.mintMcpToken(peer, target.orgId)
  const load = (token: string) => den.callMcpTool(token, "get_skill", { name })
  assert.match((await load(creatorToken)).text, /Read the synthetic field report/)
  assert.equal((await den.callMcpTool(creatorToken, "get_skill", { name, file: "references/guide.md" })).text, guide)
  assert.equal((await load(peerToken)).isError, true)
  const adminRead = await load(adminToken)
  t.diagnostic(`Importing admin agent can load the imported private skill: ${!adminRead.isError && adminRead.text.includes(contents)}`)

  await importConfig()
  const after = expectStatus(await b("GET", "/v1/config-blobs/export?areas=plugins.skills,plugins.plugins"), 200)
  for (const area of ["skills", "plugins"]) {
    assert.equal(list(field(after, "areas", "plugins", area, "items")).filter((item) => item.name === name).length, 1)
  }
})
