import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { SandboxOrganizationTable as Sandbox } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import { MEMBER_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH } from "@openwork/free-auto"
import { bootDen, field, text } from "./harness.js"

const den = await bootDen({ env: { INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_OPENAI_API_KEY: "fixture-only", ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "fixture-accounting-0000000000000000000" } })
const { db } = await import("../../src/db.js")
const { createFreeMemberHandler } = await import("../../../gateway/src/free/member/handler.js")
const { createFreeAllowanceStore } = await import("../../../gateway/src/free/shared/allowance.js")
const { readAutoConfig } = await import("../../../gateway/src/free/shared/config.js")
const { findMemberFreePrincipal, readFreePrincipalDefaultPinned } = await import("../../../gateway/src/free/shared/principal.js")
const { findActiveInferenceKey } = await import("../../../gateway/src/keys.js")
const { inferenceAuth } = await import("../../../gateway/src/middleware/inference-auth.js")
const config = readAutoConfig(process.env)
const member = createFreeMemberHandler({
  config, store: createFreeAllowanceStore(config, "member", db),
  findMember: key => findMemberFreePrincipal(key, db),
  defaultPinned: principal => readFreePrincipalDefaultPinned(principal, db),
  fetch: async () => { throw new Error("Ended sandbox request reached upstream") },
})
const gateway = new Hono<import("../../../gateway/src/middleware/inference-auth.js").InferenceAuthEnv>()
gateway.use("*", inferenceAuth({ findActiveInferenceKey }))
gateway.all("*", c => {
  const identity = c.get("inference")
  assert.equal(identity.kind, "models")
  return member(c, identity.key)
})
after(async () => {
  const { client } = await import("../../../gateway/src/db.js")
  if ("end" in client) await client.end()
  await den.close()
})

test("Free identifies an expired or closed sandbox and issues a credential after reopening", async () => {
  const owner = await den.signUp("Sandbox owner")
  const { orgId } = await den.createOrg(owner, "Sample sandbox")
  const id = createDenTypeId("sandboxOrganization")
  const yesterday = new Date(Date.now() - 86_400_000)
  const tomorrow = new Date(Date.now() + 86_400_000)
  const request = () => den.request(owner.token, "POST", "/v1/inference/free/credential", { orgId })
  const issued = await request()
  assert.equal(issued.status, 200)
  const key = text(field(issued.body, "credential", "apiKey"), "member credential")
  await db.insert(Sandbox).values({ id, organizationId: normalizeDenTypeId("organization", orgId),
    createdByUserId: normalizeDenTypeId("user", owner.userId), joinToken: id, memberLimit: 2, expiresAt: yesterday })
  async function expectSandboxEnded() {
    for (const [path, property] of [["/v1/inference/access", "access"], ["/v1/inference/free/provider", "provider"]]) {
      const result = await den.request(owner.token, "GET", path, { orgId })
      assert.equal(result.status, 200)
      assert.equal(field(result.body, property, "reason"), "admin_disabled")
      assert.equal(field(result.body, property, "reasonDetail"), "free_sandbox_ended")
    }
    for (const [method, path] of [["GET", MEMBER_FREE_STATUS_PATH], ["POST", MEMBER_FREE_CHAT_PATH]]) {
      const cached = await gateway.request(path, { method, headers: { authorization: "Bearer " + key },
        ...(method === "POST" ? { body: JSON.stringify({ model: "openwork/auto", messages: [{ role: "user", content: "Hello" }] }) } : {}),
      })
      assert.equal(cached.status, 403)
      assert.equal(field(await cached.json(), "error", "code"), "free_sandbox_ended")
    }
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
