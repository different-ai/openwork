import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { SandboxOrganizationTable as Sandbox } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const path = "/v1/org/sandbox-status"

test("members see their own trial lifecycle when enabled, including after renewal", async () => {
  const owner = await den.signUp("Trial owner")
  const { orgId } = await den.createOrg(owner, "Trial organization")
  const member = await den.newMember(owner, orgId, "Trial member")
  const stranger = await den.signUp("Separate member")
  const ordinary = await den.createOrg(stranger, "Ordinary organization")
  const id = createDenTypeId("sandboxOrganization")
  const yesterday = new Date(Date.now() - 86_400_000)
  const tomorrow = new Date(Date.now() + 86_400_000)
  await db.insert(Sandbox).values({
    id, organizationId: normalizeDenTypeId("organization", orgId),
    createdByUserId: normalizeDenTypeId("user", owner.userId), joinToken: id,
    memberLimit: 3, expiresAt: yesterday,
  })
  const status = async (expected: string | null) => {
    const result = await den.request(member.token, "GET", path, { orgId })
    assert.equal(result.status, 200)
    assert.equal(result.headers.get("cache-control"), "no-store")
    assert.deepEqual(result.body, { state: expected })
  }
  await status(null)
  assert.equal((await den.setFeature(orgId, "endedSandboxNotice", true)).status, 200)
  await status("expired")
  assert.equal((await den.request(member.token, "GET", "/v1/org", { orgId })).status, 200)
  assert.equal((await den.request(null, "GET", path, { orgId })).status, 401)
  assert.equal((await den.request(stranger.token, "GET", path, { orgId })).status, 404)
  assert.equal((await den.setFeature(ordinary.orgId, "endedSandboxNotice", true)).status, 200)
  assert.deepEqual((await den.request(stranger.token, "GET", path, { orgId: ordinary.orgId })).body, { state: null })
  await db.update(Sandbox).set({ closedAt: yesterday, expiresAt: tomorrow }).where(eq(Sandbox.id, id))
  await status("closed")
  await db.update(Sandbox).set({ closedAt: null }).where(eq(Sandbox.id, id))
  await status("open")
})
