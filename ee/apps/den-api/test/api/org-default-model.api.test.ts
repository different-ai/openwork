import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { OrgDefaultModelTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { DEFAULT_MODEL_EVERYONE_SCOPE } from "@openwork/types/den/default-model"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen({ productionLike: true })
after(() => den.close())
const settings = "/v1/org/default-model"
const everyone = `${settings}/everyone`

async function addModel(call: ReturnType<typeof den.as>) {
  const created = await call("POST", "/v1/llm-providers", {
    name: "Example provider", source: "custom", allMembers: true, memberIds: [], teamIds: [],
    apiKey: "fixture-key",
    customConfig: {
      id: "example-provider", name: "Example provider", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1" }, env: ["EXAMPLE_MODEL_KEY"],
      models: [{ id: "example-model", name: "Example model", tool_call: true }],
    },
  })
  assert.equal(created.status, 201, summary(created))
  return { providerId: text(field(created.body, "llmProvider", "id"), "provider id"), modelId: "example-model" }
}

test("everyone defaults stay separate by organization and are visible immediately on repeated saves", async () => {
  const first = await den.createOrg(await den.signUp("First owner"), "First organization")
  const second = await den.createOrg(await den.signUp("Second owner"), "Second organization")
  const firstOwner = den.as(first.owner, first.orgId)
  const secondOwner = den.as(second.owner, second.orgId)
  const firstModel = await addModel(firstOwner)
  const secondModel = await addModel(secondOwner)
  const otherSave = await secondOwner("PUT", everyone, { model: secondModel })
  assert.equal(otherSave.status, 200, summary(otherSave))
  assert.deepEqual(field(otherSave.body, "everyone"), secondModel)

  const { db } = await import("../../src/db.js")
  const scope = and(
    eq(OrgDefaultModelTable.organizationId, normalizeDenTypeId("organization", first.orgId)),
    eq(OrgDefaultModelTable.scopeKey, DEFAULT_MODEL_EVERYONE_SCOPE),
  )
  const ids = { id: OrgDefaultModelTable.id }
  assert.ok(den.production)
  await den.production.freeze()
  try {
    const save = await firstOwner("PUT", everyone, { model: firstModel })
    assert.equal(save.status, 200, summary(save))
    assert.deepEqual(field(save.body, "everyone"), firstModel)
    const read = await firstOwner("GET", settings)
    assert.equal(read.status, 200, summary(read))
    assert.deepEqual(field(read.body, "everyone"), firstModel)
    assert.deepEqual(await db.select(ids).from(OrgDefaultModelTable).where(scope), [], "replica still predates the save")
    const rows = await db.$primary.select(ids).from(OrgDefaultModelTable).where(scope)
    assert.equal(rows.length, 1)

    const repeat = await firstOwner("PUT", everyone, { model: firstModel })
    assert.equal(repeat.status, 200, summary(repeat))
    assert.deepEqual(field(repeat.body, "everyone"), firstModel)
    assert.deepEqual(await db.$primary.select(ids).from(OrgDefaultModelTable).where(scope), rows)

    const otherRead = await secondOwner("GET", settings)
    assert.equal(otherRead.status, 200, summary(otherRead))
    assert.deepEqual(field(otherRead.body, "everyone"), secondModel)
    const outside = den.as(second.owner, first.orgId)
    for (const denied of [await outside("GET", settings), await outside("PUT", everyone, { model: null })]) {
      assert.equal(denied.status, 404, summary(denied))
      assert.equal(field(denied.body, "error"), "organization_not_found")
    }
    const retained = await firstOwner("GET", settings)
    assert.equal(retained.status, 200, summary(retained))
    assert.deepEqual(field(retained.body, "everyone"), firstModel)
  } finally {
    await den.production.thaw()
  }
})
