import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AuthAccountTable, ScimProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

const den = await bootDen({ env: { DEN_PLAN_GATING_ENABLED: "true" } })
after(() => den.close())
const { client, db } = await import("../../src/db.js")
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
  } }, { type: "command", input: { rawSourceText: "---\nname: field-command\n---\n\nRead field notes.", metadata: { title: "field-command" } } }] }), 201)
  const flagOff = expectStatus(await a("GET", "/v1/config-blobs/export?areas=plugins.skills,plugins.plugins"), 200)
  for (const area of ["skills", "plugins"]) {
    assert.equal(list(field(flagOff, "areas", "plugins", area, "items")).some((item) => item.name === name), false, `Flag off: private ${area} are not exported`)
  }
  expectStatus(await den.setFeature(source.orgId, "configPrivateItems", true), 200)
  expectStatus(await den.setFeature(target.orgId, "configPrivateItems", true), 200)
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

  async function importConfig(api = b, file = blob) {
    const submitted = expectStatus(await api("POST", "/v1/config-blobs/change-requests", { blob: file, mode: "merge" }), 202)
    const id = text(field(submitted, "changeRequest", "id"), "request id")
    const analyzed = await settle(api, id)
    assert.equal(field(analyzed, "changeRequest", "status"), "needs_review", JSON.stringify(analyzed))
    const plan = expectStatus(await api("GET", `/v1/config-blobs/change-requests/${id}/plan`), 200)
    assert.equal(field(plan, "plan", "summary", "blocking"), 0, JSON.stringify(plan))
    const planHash = text(field(plan, "plan", "planHash"), "plan hash")
    expectStatus(await api("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash }), 200)
    const applied = await settle(api, id)
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
  assert.equal(adminRead.isError, true, "the importing admin agent does not acquire the creator-only skill")

  const skillTarget = await den.createOrg(await den.signUp("Skills Only Admin"), "Skills only workspace")
  const skillOwner = await den.join(skillTarget.owner, skillTarget.orgId, creator)
  const skillAdmin = den.as(skillTarget.owner, skillTarget.orgId)
  expectStatus(await den.setFeature(skillTarget.orgId, "configPrivateItems", true), 200)
  await importConfig(skillAdmin, skillsOnly)
  const skillOnlyExport = expectStatus(await skillAdmin("GET", "/v1/config-blobs/export?areas=plugins.skills"), 200)
  assert.ok(list(field(skillOnlyExport, "areas", "plugins", "skills", "items")).some((item) => item.name === name))
  const skillOnlyRead = await load(await den.mintMcpToken(skillOwner, skillTarget.orgId))
  t.diagnostic(`Skills-only import is loadable by the owner agent: ${!skillOnlyRead.isError && skillOnlyRead.text.includes(contents)}`)

  await importConfig()
  const after = expectStatus(await b("GET", "/v1/config-blobs/export?areas=plugins.skills,plugins.plugins"), 200)
  for (const area of ["skills", "plugins"]) {
    assert.equal(list(field(after, "areas", "plugins", area, "items")).filter((item) => item.name === name).length, 1)
  }
})

test("same-named creator-only plugins arrive separately and do not replace shared names", async () => {
  const source = await den.createOrg(await den.signUp("Names Source"), "Names workspace")
  const first = await den.newMember(source.owner, source.orgId, "First Creator")
  const second = await den.newMember(source.owner, source.orgId, "Second Creator")
  const name = `same-name-${den.stamp}`
  const skill = (witness: string) => ({ type: "skill", input: { rawSourceText: `---\nname: ${name}\ndescription: Synthetic ownership check.\n---\n\n${witness}` } })
  for (const [owner, witness] of [[first, "First private witness."], [second, "Second private witness."]] as const) {
    expectStatus(await den.as(owner, source.orgId)("POST", "/v1/plugins", { name, components: [skill(witness)] }), 201)
  }
  expectStatus(await den.setFeature(source.orgId, "configPrivateItems", true), 200)
  const blob = expectStatus(await den.as(source.owner, source.orgId)("GET", "/v1/config-blobs/export?areas=plugins.skills,plugins.plugins"), 200)
  for (const withShared of [false, true]) {
    const target = await den.createOrg(await den.signUp(withShared ? "Shared Target" : "Empty Target"), "Names destination")
    const a = await den.join(target.owner, target.orgId, first)
    const b = await den.join(target.owner, target.orgId, second)
    const admin = den.as(target.owner, target.orgId)
    expectStatus(await den.setFeature(target.orgId, "configPrivateItems", true), 200)
    let sharedId: string | null = null
    if (withShared) {
      const shared = expectStatus(await admin("POST", "/v1/plugins", { name, orgWide: true, components: [skill("Original shared witness.")] }), 201)
      sharedId = text(field(shared, "item", "id"), "shared plugin id")
    }
    const submitted = expectStatus(await admin("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge" }), 202)
    const id = text(field(submitted, "changeRequest", "id"), "request id")
    const analyzed = await settle(admin, id)
    assert.equal(field(analyzed, "changeRequest", "status"), "needs_review", JSON.stringify(analyzed))
    const plan = expectStatus(await admin("GET", `/v1/config-blobs/change-requests/${id}/plan`), 200)
    assert.equal(field(plan, "plan", "summary", "blocking"), 0, JSON.stringify(plan))
    expectStatus(await admin("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: field(plan, "plan", "planHash") }), 200)
    const applied = await settle(admin, id)
    assert.equal(field(applied, "changeRequest", "status"), "applied", JSON.stringify(applied))
    const [rows] = await mysql.execute("SELECT p.id, p.created_by_org_membership_id AS owner, c.id AS skill_id FROM plugin p JOIN plugin_config_object pc ON pc.plugin_id = p.id AND pc.removed_at IS NULL JOIN config_object c ON c.id = pc.config_object_id WHERE p.organization_id = ? AND p.name = ?", [target.orgId, name])
    const bindings = list(rows)
    assert.equal(bindings.length, withShared ? 3 : 2)
    for (const [owner, stranger, witness] of [[a, b, "First private witness."], [b, a, "Second private witness."]] as const) {
      const binding = bindings.find((row) => row.owner === owner.memberId)
      assert.ok(binding)
      const qualified = `plugin:${binding.id}:${binding.skill_id}`
      const ownerRead = await den.callMcpTool(await den.mintMcpToken(owner, target.orgId), "get_skill", { name: qualified })
      assert.ok(ownerRead.text.includes(witness), JSON.stringify(ownerRead))
      assert.equal((await den.callMcpTool(await den.mintMcpToken(stranger, target.orgId), "get_skill", { name: qualified })).isError, true)
    }
    if (sharedId) {
      const shared = bindings.find((row) => row.id === sharedId)
      assert.ok(shared)
      const sharedRead = await den.callMcpTool(await den.mintMcpToken(a, target.orgId), "get_skill", { name: `plugin:${shared.id}:${shared.skill_id}` })
      assert.ok(sharedRead.text.includes("Original shared witness."), JSON.stringify(sharedRead))
    }
  }
})

test("Config reviews a SCIM-owned skill only after its owner is provisioned", async () => {
  const source = await den.createOrg(await den.signUp("Directory Source"), "Directory source")
  const target = await den.createOrg(await den.signUp("Directory Target"), "Directory target")
  const creator = await den.newMember(source.owner, source.orgId, "Directory Member")
  async function seedProvider(orgId: string) {
    const providerId = `directory-${orgId}`
    await db.insert(ScimProviderTable).values({ id: createDenTypeId("scimProvider"), providerId,
      organizationId: normalizeDenTypeId("organization", orgId), scimToken: "synthetic-not-a-live-token" })
    return providerId
  }
  async function seedDirectoryAccount(providerId: string) {
    await db.insert(AuthAccountTable).values({ id: createDenTypeId("account"), providerId, accountId: `account-${providerId}`,
      userId: normalizeDenTypeId("user", creator.userId) })
  }
  await seedDirectoryAccount(await seedProvider(source.orgId))
  const targetProvider = await seedProvider(target.orgId)
  for (const orgId of [source.orgId, target.orgId]) expectStatus(await den.setFeature(orgId, "configPrivateItems", true), 200)
  const name = `directory-skill-${den.stamp}`
  expectStatus(await den.as(creator, source.orgId)("POST", "/v1/plugins", { name, components: [{ type: "skill", input: {
    rawSourceText: `---\nname: ${name}\ndescription: Synthetic directory review.\n---\n\nRead the directory witness.`,
  } }] }), 201)
  const blob = expectStatus(await den.as(source.owner, source.orgId)("GET", "/v1/config-blobs/export?areas=members.people,plugins.skills,plugins.plugins"), 200)
  const person = list(field(blob, "areas", "members", "people", "items")).find((item) => field(item, "spec", "email") === creator.email)
  assert.equal(field(person, "spec", "managedBy"), "scim")
  const admin = den.as(target.owner, target.orgId)
  async function review() {
    const submitted = expectStatus(await admin("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge" }), 202)
    const id = text(field(submitted, "changeRequest", "id"), "request id")
    await settle(admin, id)
    return expectStatus(await admin("GET", `/v1/config-blobs/change-requests/${id}/plan`), 200)
  }
  const early = await review()
  assert.ok(Number(field(early, "plan", "summary", "blocking")) > 0)
  assert.match(JSON.stringify(early), /SCIM provisions them/)
  assert.match(JSON.stringify(early), /ref_unresolved/)
  await den.join(target.owner, target.orgId, creator)
  await seedDirectoryAccount(targetProvider)
  const late = await review()
  assert.equal(field(late, "plan", "summary", "blocking"), 0, JSON.stringify(late))
})
