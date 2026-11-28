import assert from "node:assert/strict"
import { after, test } from "node:test"
import { Hono } from "hono"
import { eq } from "@openwork-ee/den-db/drizzle"
import { SandboxOrganizationTable as Sandbox } from "@openwork-ee/den-db/schema"
import { sandboxTrialEnded } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { parseGatewayModelAlias } from "@openwork-ee/gateway-catalog"
import type { InferenceEnv } from "../../../gateway/src/proxy.js"
import { bootDen, field } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, memberGatewayKey, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const den = await bootDen({ env: gatewayFixtureEnv })
const { db } = await import("../../src/db.js")
const { registerGatewayRoutes } = await import("../../../gateway/src/gateway.js")
const { gatewayAuth } = await import("../../../gateway/src/middleware/gateway-auth.js")
const { findActiveGatewayKey } = await import("../../../gateway/src/keys.js")
const { loadOrganizationFromDb, orgContext } = await import("../../../gateway/src/middleware/org-context.js")
after(async () => {
  restoreCatalog()
  const { client } = await import("../../../gateway/src/db.js")
  if ("end" in client) await client.end()
  await den.close()
})

test("a rejected sponsored model explains expiry while independent credentials keep their own result", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Trial owner"), "Trial workspace")
  const sponsored = (await grantGatewayModels(den, owner, orgId, [owner]))["gpt-6-luna"]
  const independent = (await grantGatewayModels(den, owner, orgId, [owner], ["gpt-fixture-other"]))["gpt-fixture-other"]
  const selection = parseGatewayModelAlias(sponsored)
  assert.ok(selection)
  const key = await memberGatewayKey(orgId, owner)
  const id = createDenTypeId("sandboxOrganization")
  const yesterday = new Date(Date.now() - 86_400_000)
  const tomorrow = new Date(Date.now() + 86_400_000)
  await db.insert(Sandbox).values({
    id, organizationId: normalizeDenTypeId("organization", orgId), createdByUserId: normalizeDenTypeId("user", owner.userId),
    sponsoredSetId: selection.credentialSetId, joinToken: id, memberLimit: 2, expiresAt: yesterday,
  })

  let upstreamStatus = 401
  const gateway = new Hono<InferenceEnv>()
  gateway.use("*", gatewayAuth({ findActiveGatewayKey }), orgContext({ loadOrganization: loadOrganizationFromDb }))
  registerGatewayRoutes(gateway, {
    sponsoredTrialEnded: (org, set) => sandboxTrialEnded(db, org, set),
    fetch: async () => upstreamStatus === 200
      ? Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })
      : Response.json({ error: { message: "Provider refused request" } }, { status: upstreamStatus }),
    insertRequestLog: async () => {}, updateRequestLog: async () => true,
    reporter: { request() {}, handledError() {} },
  })
  const send = (model: string) => gateway.request("/api/v1/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK" }] }),
  })
  async function expectError(model: string, status: number, code: string) {
    const result = await send(model)
    const body = await result.json()
    assert.equal(field(body, "error", "code"), code)
    assert.equal(result.status, status)
    assert.ok(result.headers.get("x-openwork-request-id"))
  }
  async function expectReply(model: string) {
    const result = await send(model)
    assert.equal(result.status, 200)
    const body = await result.json()
    assert.equal(body.choices[0].message.content, "OK")
  }
  await expectError(sponsored, 403, "sandbox_trial_ended")
  await expectError(independent, 401, "provider_authentication_failed")
  upstreamStatus = 200
  await expectReply(independent)
  await db.update(Sandbox).set({ closedAt: yesterday, expiresAt: tomorrow }).where(eq(Sandbox.id, id))
  upstreamStatus = 403
  await expectError(sponsored, 403, "sandbox_trial_ended")
  await db.update(Sandbox).set({ closedAt: null }).where(eq(Sandbox.id, id))
  await expectError(sponsored, 403, "provider_permission_denied")
  upstreamStatus = 200
  await expectReply(sponsored)
  await db.update(Sandbox).set({ expiresAt: yesterday, sponsoredSetId: null }).where(eq(Sandbox.id, id))
  upstreamStatus = 401
  await expectError(sponsored, 401, "provider_authentication_failed")
})
