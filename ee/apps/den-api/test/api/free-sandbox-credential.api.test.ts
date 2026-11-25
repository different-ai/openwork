import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { SandboxOrganizationTable as Sandbox } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen } from "./harness.js"

const den = await bootDen({ env: { INFERENCE_FREE_ENABLED: "true" } })
after(() => den.close())
const { db } = await import("../../src/db.js")

test("Free identifies an expired or closed sandbox and issues a credential after reopening", async () => {
  const owner = await den.signUp("Sandbox owner")
  const { orgId } = await den.createOrg(owner, "Sample sandbox")
  const id = createDenTypeId("sandboxOrganization")
  const yesterday = new Date(Date.now() - 86_400_000)
  const tomorrow = new Date(Date.now() + 86_400_000)
  await db.insert(Sandbox).values({ id, organizationId: normalizeDenTypeId("organization", orgId),
    createdByUserId: normalizeDenTypeId("user", owner.userId), joinToken: id, memberLimit: 2, expiresAt: yesterday })
  const request = () => den.request(owner.token, "POST", "/v1/inference/free/credential", { orgId })
  async function expectSandboxEnded() {
    const reply = await request()
    assert.equal(reply.status, 403)
    assert.deepEqual(reply.body, { error: "free_not_offered", reason: "free_sandbox_ended", message: "This sandbox has ended. A platform admin can reopen it." })
  }
  await expectSandboxEnded()
  await db.update(Sandbox).set({ expiresAt: tomorrow, closedAt: yesterday }).where(eq(Sandbox.id, id))
  await expectSandboxEnded()
  await db.update(Sandbox).set({ closedAt: null }).where(eq(Sandbox.id, id))
  assert.equal((await request()).status, 200)
})
