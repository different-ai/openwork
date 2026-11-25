import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { FreeAutoOrgFounderTable as Founder } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")

async function founder(orgId: string) {
  const [row] = await db.$primary.select().from(Founder).where(eq(Founder.organization_id, normalizeDenTypeId("organization", orgId)))
  return row?.founder_user_id
}

test("one account can found multiple organizations through Den and Better Auth and invite other people", async () => {
  const owner = await den.signUp("Workspace owner")
  const first = await den.createOrg(owner, "First workspace")
  await den.newMember(owner, first.orgId, "Workspace teammate")
  const second = await den.request(owner.token, "POST", "/api/auth/organization/create", {
    headers: { cookie: owner.cookie }, body: { name: "Second workspace", slug: "second-workspace" },
  })
  assert.equal(second.status, 200, summary(second))
  const secondId = text(field(second.body, "id"), "organization id")
  assert.notEqual(first.orgId, secondId)
  assert.equal(await founder(first.orgId), owner.userId)
  assert.equal(await founder(secondId), owner.userId)
})

test("a provisional organization gets its founder from the accepted owner claim", async () => {
  const owner = await den.signUp("Claiming owner")
  const provisional = await den.request(null, "POST", "/v1/bootstrap/workspace", { body: { workspaceName: "Claimed workspace" } })
  assert.equal(provisional.status, 200)
  const orgId = text(field(provisional.body, "organization", "id"), "provisional organization id")
  assert.equal(await founder(orgId), undefined)
  const [link] = list(field(provisional.body, "claimLinks"))
  const claimed = await den.request(owner.token, "POST", "/v1/bootstrap/claims/accept", { body: { token: link.token } })
  assert.equal(claimed.status, 200)
  assert.equal(await founder(orgId), owner.userId)
})
