import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const defaults = ["Ollama", "OpenAI Image Gen", "OpenWork Browser"]
const edgeKinds = (item: unknown) => list(field(item, "edges")).map((edge) => edge.kind)

test("marketplace seeds are shared, not owned by the member whose read seeded them", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Workspace owner"), "Marketplace workspace")
  const member = await den.newMember(owner, orgId, "First member")
  const a = den.as(member, orgId)
  const b = den.as(await den.newMember(owner, orgId, "Second member"), orgId)
  const admin = den.as(await den.newMember(owner, orgId, "Workspace admin", "admin"), orgId)

  const before = await a("GET", "/v1/me/library")
  assert.equal(before.status, 200, summary(before))
  assert.equal(list(field(before.body, "items")).filter((item) => item.type === "plugin").length, 0)
  const seeded = await a("GET", "/v1/marketplaces")
  assert.equal(seeded.status, 200, summary(seeded))
  const marketplaceId = text(list(field(seeded.body, "items")).find((item) => item.name === "OpenWork Marketplace")?.id, "marketplace id")

  async function library(call: typeof a) {
    const response = await call("GET", "/v1/me/library")
    assert.equal(response.status, 200, summary(response))
    return list(field(response.body, "items")).filter((item) => item.type === "plugin")
  }
  const first = await library(a)
  assert.deepEqual(first.map((item) => item.name).sort(), defaults)
  for (const item of first) {
    assert.equal(item.role, "viewer", String(item.name))
    assert.deepEqual(edgeKinds(item), ["org_wide", "catalog"])
  }
  assert.deepEqual(await library(b), first)

  const builtInId = text(first[0]?.id, "built-in plugin id")
  const detail = await a("GET", `/v1/plugins/${builtInId}`)
  assert.equal(detail.status, 200, summary(detail))
  assert.equal(field(detail.body, "item", "createdByOrgMembershipId"), null)

  const created = await a("POST", "/v1/plugins", { name: "Member plugin" })
  assert.equal(created.status, 201, summary(created))
  const createdId = text(field(created.body, "item", "id"), "member plugin id")
  const attached = await admin("POST", `/v1/marketplaces/${marketplaceId}/plugins`, { pluginId: createdId })
  assert.equal(attached.status, 201, summary(attached))
  const mine = (await library(a)).find((item) => item.id === createdId)
  assert.equal(mine?.role, "manager")
  assert.ok(edgeKinds(mine).includes("mine"))

  const archivePath = `/v1/plugins/${builtInId}/archive`
  const denied = await a("POST", archivePath)
  assert.equal(denied.status, 403, summary(denied))
  const archived = await admin("POST", archivePath)
  assert.equal(archived.status, 200, summary(archived))
  assert.equal(field(archived.body, "item", "status"), "archived")
  assert.ok(!(await library(b)).some((item) => item.id === builtInId))
})
