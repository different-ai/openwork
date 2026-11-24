import assert from "node:assert/strict"
import { after, test } from "node:test"
import { PERSONAL_SKILLS_FORMAT, personalSkillsBundleSchema } from "@openwork/types/den/personal-skills"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const from = await den.createOrg(await den.signUp("Workspace Owner"), "Original workspace")
const author = await den.newMember(from.owner, from.orgId, "Skill Author")
const peer = await den.newMember(from.owner, from.orgId, "Skill Peer")
const to = await den.createOrg(await den.signUp("Destination Owner"), "Destination workspace")
const recipient = await den.newMember(to.owner, to.orgId, "Skill Recipient")
const foreign = await den.createOrg(author, "Foreign workspace")
const EXPORT = "/v1/me/personal-skills/export"
const IMPORT = "/v1/me/personal-skills/import"
const markdown = (name: string, body = "Summarize this week's notes.") => `---\nname: ${name}\ndescription: Help with weekly notes.\n---\n\n${body}`
const bundle = (...sources: string[]) => ({ format: PERSONAL_SKILLS_FORMAT, version: 1, skills: sources.map((source) => ({ source })) })

async function createSkill(member: Member, orgId: string, source: string, sourceMode: "cloud" | "import" = "cloud") {
  const result = await den.as(member, orgId)("POST", "/v1/config-objects", { type: "skill", sourceMode, input: { rawSourceText: source } })
  assert.equal(result.status, 201, summary(result))
  return text(field(result.body, "item", "id"), "config object id")
}

async function createPlugin(member: Member, orgId: string, name: string, source: string) {
  const result = await den.as(member, orgId)("POST", "/v1/plugins", { name, components: [{ type: "skill", input: { rawSourceText: source } }] })
  assert.equal(result.status, 201, summary(result))
  return text(field(result.body, "item", "id"), "plugin id")
}

async function enable(orgId: string) {
  const enabled = await den.setFeature(orgId, "personalSkillPortability", true)
  assert.equal(enabled.status, 200, summary(enabled))
}

test("personal portability requires an enabled workspace, current membership, and a fresh user session", async () => {
  for (const [method, path, body] of [["GET", EXPORT, undefined], ["POST", IMPORT, bundle()]] as const) {
    const disabled = await den.as(author, from.orgId)(method, path, body)
    assert.equal(disabled.status, 404, summary(disabled))
    assert.equal(field(disabled.body, "error"), "feature_disabled")
    assert.equal(disabled.headers.get("cache-control"), "no-store")
    assert.equal((await den.request(null, method, path, { orgId: from.orgId, body })).status, 401)
  }
  await enable(from.orgId)
  const token = await den.mintMcpToken(author, from.orgId)
  const apiKey = await den.as(from.owner, from.orgId)("POST", "/v1/api-keys", { name: "Portability test key" })
  assert.equal(apiKey.status, 201, summary(apiKey))
  const secret = text(field(apiKey.body, "key") ?? field(apiKey.body, "apiKey", "key"), "api key")
  const stale = await den.newMember(from.owner, from.orgId, "Stale Sign In")
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("API test requires isolated MySQL")
  await client.execute("UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE user_id = ?", [stale.userId])
  for (const [method, path, body] of [["GET", EXPORT, undefined], ["POST", IMPORT, bundle()]] as const) {
    assert.equal((await den.as(recipient, from.orgId)(method, path, body)).status, 404)
    assert.notEqual((await den.request(token, method, path, { body, orgId: from.orgId })).status, 200)
    const apiRefused = await den.request(null, method, path, { body, orgId: from.orgId, headers: { "x-api-key": secret } })
    assert.equal(apiRefused.status, 403, summary(apiRefused))
    const reauth = await den.as(stale, from.orgId)(method, path, body)
    assert.equal(reauth.status, 403, summary(reauth))
    assert.equal(field(reauth.body, "reason"), "fresh_auth_required")
  }
})

test("export returns latest source only for one's own active unshared manual skills in this workspace", async () => {
  await enable(from.orgId)
  const privateSource = markdown("private-solo", "Updated instructions.")
  const standalone = await createSkill(author, from.orgId, markdown("private-solo"))
  const edited = await den.as(author, from.orgId)("POST", `/v1/config-objects/${standalone}/versions`, { input: {
    rawSourceText: privateSource,
    normalizedPayloadJson: { custom: "not-in-export", files: [{ path: "notes.md", text: "Supporting file, not portable." }] },
  } })
  assert.equal(edited.status, 201, summary(edited))
  const privatePlugin = markdown("private-plugin")
  await createPlugin(author, from.orgId, "Private plugin", privatePlugin)
  const plugin = await createPlugin(author, from.orgId, "Shared plugin", markdown("shared-plugin"))
  const direct = await createSkill(author, from.orgId, markdown("shared-direct"))
  for (const path of [`/v1/plugins/${plugin}/access`, `/v1/config-objects/${direct}/access`]) {
    const shared = await den.as(author, from.orgId)("POST", path, { orgMembershipId: peer.memberId, role: "viewer" })
    assert.equal(shared.status, 201, summary(shared))
  }
  const published = await createPlugin(from.owner, from.orgId, "Listed plugin", markdown("listed-plugin"))
  const market = await den.as(from.owner, from.orgId)("POST", "/v1/marketplaces", { name: "Shared marketplace" })
  assert.equal(market.status, 201, summary(market))
  const marketId = text(field(market.body, "item", "id"), "marketplace id")
  const listed = await den.as(from.owner, from.orgId)("POST", `/v1/marketplaces/${marketId}/plugins`, { pluginId: published })
  assert.equal(listed.status, 201, summary(listed))
  await createSkill(author, from.orgId, markdown("repository-import"), "import")
  const archived = await createSkill(author, from.orgId, markdown("archived-skill"))
  assert.equal((await den.as(author, from.orgId)("POST", `/v1/config-objects/${archived}/archive`)).status, 200)
  await createSkill(author, foreign.orgId, markdown("wrong-workspace"))

  const exported = await den.as(author, from.orgId)("GET", EXPORT)
  assert.equal(exported.status, 200, summary(exported))
  assert.equal(exported.headers.get("cache-control"), "no-store")
  assert.deepEqual(personalSkillsBundleSchema.parse(exported.body).skills.map(({ source }) => source).sort(), [privateSource, privatePlugin].sort())
  for (const member of [peer, from.owner]) {
    const theirExport = await den.as(member, from.orgId)("GET", EXPORT)
    assert.equal(theirExport.status, 200, summary(theirExport))
    assert.deepEqual(theirExport.body, bundle())
  }
})

test("import validates the whole format before creation and explicitly creates fresh private copies without overwrite", async () => {
  await enable(to.orgId)
  const source = markdown("same-name", "New instructions.")
  const existingSource = markdown("same-name", "Keep these existing instructions.")
  const existing = await createSkill(recipient, to.orgId, existingSource)
  const invalid = [
    { ...bundle(source), format: "not-personal-skills" },
    { ...bundle(source), version: 2 },
    { ...bundle(source), owner: to.owner.memberId },
    { ...bundle(source), skills: [{ source, orgWide: true }] },
    bundle(source, "not a SKILL.md"),
  ]
  for (const body of invalid) {
    const refused = await den.as(recipient, to.orgId)("POST", IMPORT, body)
    assert.equal(refused.status, 400, summary(refused))
    assert.equal(refused.headers.get("cache-control"), "no-store")
  }
  assert.deepEqual((await den.as(recipient, to.orgId)("GET", EXPORT)).body, bundle(existingSource))
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const imported = await den.as(recipient, to.orgId)("POST", IMPORT, bundle(source))
    assert.equal(imported.status, 200, summary(imported))
    assert.deepEqual(imported.body, { created: 1 })
    assert.equal(imported.headers.get("cache-control"), "no-store")
  }
  const old = await den.as(recipient, to.orgId)("GET", `/v1/config-objects/${existing}`)
  assert.equal(field(old.body, "item", "latestVersion", "rawSourceText"), existingSource)
  const newExport = personalSkillsBundleSchema.parse((await den.as(recipient, to.orgId)("GET", EXPORT)).body)
  assert.deepEqual(newExport.skills.map((item) => item.source).sort(), [source, source, existingSource].sort())
  const plugins = await den.as(recipient, to.orgId)("GET", "/v1/plugins")
  const copies = list(field(plugins.body, "items")).filter((item) => String(item.name).startsWith("same-name (copy "))
  assert.equal(copies.length, 2, summary(plugins))
  for (const plugin of copies) {
    const grants = await den.as(recipient, to.orgId)("GET", `/v1/plugins/${plugin.id}/access`)
    assert.equal(grants.status, 200, summary(grants))
    const grant = list(field(grants.body, "items"))
    assert.equal(grant.length, 1, summary(grants))
    assert.equal(grant[0]?.orgMembershipId, recipient.memberId)
  }
})
