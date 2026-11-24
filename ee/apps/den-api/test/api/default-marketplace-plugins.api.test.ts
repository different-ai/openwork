import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { RETIRED_DEFAULT_OPENWORK_PLUGINS } from "../../src/routes/org/plugin-system/default-marketplaces.js"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("API test requires isolated MySQL")

const names = (body: unknown) => list(field(body, "items")).map((entry) => String(entry.name))

async function library(member: Member, orgId: string) {
  const marketplaces = await den.as(member, orgId)("GET", "/v1/marketplaces")
  assert.equal(marketplaces.status, 200, summary(marketplaces))
  const plugins = await den.as(member, orgId)("GET", "/v1/plugins?status=active")
  assert.equal(plugins.status, 200, summary(plugins))
  return { marketplaces: list(field(marketplaces.body, "items")), plugins: names(plugins.body) }
}

/** A plugin as earlier Den builds seeded it: a name and description in the OpenWork Marketplace, nothing else. */
async function seedLegacyPlugin(input: { orgId: string; memberId: string; marketplaceId: string; name: string; description: string }) {
  const pluginId = createDenTypeId("plugin")
  await client.execute(
    "INSERT INTO plugin (id, organization_id, name, description, status, created_by_org_membership_id) VALUES (?, ?, ?, ?, 'active', ?)",
    [pluginId, input.orgId, input.name, input.description, input.memberId],
  )
  await client.execute(
    "INSERT INTO marketplace_plugin (id, organization_id, marketplace_id, plugin_id, membership_source, created_by_org_membership_id) VALUES (?, ?, ?, ?, 'system', ?)",
    [createDenTypeId("marketplacePlugin"), input.orgId, input.marketplaceId, pluginId, input.memberId],
  )
  return pluginId
}

test("a new organization's Library holds no plugin nobody added", async () => {
  const org = await den.createOrg(await den.signUp("Fresh Owner"), "Fresh workspace")
  const first = await library(org.owner, org.orgId)
  assert.deepEqual(first.plugins, [])
  assert.deepEqual(first.marketplaces.map((entry) => [entry.name, entry.pluginCount]), [["OpenWork Marketplace", 0]])

  // Opening it again, or as someone else, adds nothing either.
  const member = await den.newMember(org.owner, org.orgId, "Second Person")
  assert.deepEqual((await library(member, org.orgId)).plugins, [])
  assert.deepEqual((await library(org.owner, org.orgId)).plugins, [])
})

test("plugins earlier builds seeded are retired while untouched, and kept once someone filled them in", async () => {
  const org = await den.createOrg(await den.signUp("Older Owner"), "Older workspace")
  const marketplaceId = text((await library(org.owner, org.orgId)).marketplaces[0]?.id, "marketplace id")

  const seeded = []
  for (const entry of RETIRED_DEFAULT_OPENWORK_PLUGINS) {
    seeded.push(await seedLegacyPlugin({ orgId: org.orgId, memberId: org.owner.memberId, marketplaceId, ...entry }))
  }
  const kept = text(seeded[1], "kept plugin id")
  const skill = await den.as(org.owner, org.orgId)("POST", "/v1/config-objects", {
    type: "skill",
    sourceMode: "cloud",
    input: { rawSourceText: "---\nname: browse-notes\ndescription: Notes for browsing.\n---\n\nOpen the page and summarize it." },
  })
  assert.equal(skill.status, 201, summary(skill))
  const attached = await den.as(org.owner, org.orgId)("POST", `/v1/plugins/${kept}/config-objects`, { configObjectId: text(field(skill.body, "item", "id"), "skill id") })
  assert.equal(attached.status, 201, summary(attached))

  // Plugins is the first thing this organization opens after the upgrade.
  const plugins = await den.as(org.owner, org.orgId)("GET", "/v1/plugins?status=active")
  assert.equal(plugins.status, 200, summary(plugins))
  assert.deepEqual(names(plugins.body), [RETIRED_DEFAULT_OPENWORK_PLUGINS[1]?.name])

  const after = await library(org.owner, org.orgId)
  assert.deepEqual(after.plugins, [RETIRED_DEFAULT_OPENWORK_PLUGINS[1]?.name])
  assert.deepEqual(after.marketplaces.map((entry) => [entry.name, entry.pluginCount]), [["OpenWork Marketplace", 1]])
})
