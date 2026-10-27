import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")

test("usable member list attests per-grant completeness, not aggregate credential readiness", { timeout: 30_000 }, async () => {
  const org = await den.createOrg(await den.signUp("Assignment Owner"), "Assignment fixture")
  const member = await den.newMember(org.owner, org.orgId, "Assignment Member")
  const [membership] = await db.select().from(MemberTable).where(eq(MemberTable.id, normalizeDenTypeId("member", member.memberId)))
  assert.ok(membership)
  const provider = createDenTypeId("inferenceProvider")
  const model = createDenTypeId("inferenceProviderModel")
  const group = createDenTypeId("gatewayModelGroup")
  const link = createDenTypeId("gatewayModelGroupModel")
  await db.insert(GatewayProviderTable).values({ id: provider, organization_id: membership.organizationId, created_by_org_membership_id: membership.id, provider_id: "openai", name: "Assignment provider", provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }, settings: {} })
  await db.insert(GatewayProviderModelTable).values({ id: model, gateway_provider_id: provider, model_id: "fixture-model", name: "Fixture model", model_config: { limit: { context: 100_000 } } })
  await db.insert(GatewayModelGroupTable).values({ id: group, gateway_provider_id: provider, name: "Granted group" })
  await db.insert(GatewayModelGroupModelTable).values({ id: link, model_group_id: group, gateway_provider_model_id: model })
  async function grantSet(name: string, configured: boolean) {
    const set = createDenTypeId("gatewayCredentialSet")
    const credential = createDenTypeId("inferenceProviderCredential")
    await db.insert(GatewayCredentialSetTable).values({ id: set, gateway_provider_id: provider, name, credential_mode: "org" })
    await db.insert(GatewayProviderAccessTable).values({ id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: provider, model_group_id: group, credential_set_id: set, org_membership_id: membership.id, audience_key: `member:${membership.id}` })
    if (configured) await db.insert(GatewayProviderCredentialTable).values({ id: credential, organization_id: membership.organizationId, gateway_provider_id: provider, credential_set_id: set, subject: "org", kind: "api_key", secret: "fixture-upstream-key" })
    return { set, credential }
  }
  const healthy = await grantSet("Healthy set", true)
  const read = async () => {
    const response = await den.as(member, org.orgId)("GET", "/v1/inference-providers?scope=usable")
    assert.equal(response.status, 200, summary(response))
    const providers = list(field(response.body, "inferenceProviders"))
    assert.equal(providers.length, 1)
    assert.equal(providers[0]?.id, provider)
    assert.ok(!response.text.includes("fixture-upstream-key"))
    return providers[0]!
  }
  let visible = await read()
  assert.equal(visible.modelAssignmentsComplete, true)
  assert.equal(list(visible.models).length, 1)
  const missing = await grantSet("Missing set", false)
  visible = await read()
  assert.equal(visible.credentialStatus, "ready", "healthy set preserves aggregate compatibility hint")
  assert.equal(list(visible.models).length, 1, "missing organization set aliases are omitted")
  assert.equal(visible.modelAssignmentsComplete, false, "omitted assigned alias cannot establish removal")
  await db.insert(GatewayProviderCredentialTable).values({ id: missing.credential, organization_id: membership.organizationId, gateway_provider_id: provider, credential_set_id: missing.set, subject: "org", kind: "api_key", secret: "fixture-upstream-key" })
  visible = await read()
  assert.equal(visible.modelAssignmentsComplete, true)
  assert.equal(list(visible.models).length, 2)
  await db.update(GatewayProviderCredentialTable).set({ expires_at: new Date(Date.now() - 1_000) }).where(eq(GatewayProviderCredentialTable.id, missing.credential))
  visible = await read()
  assert.equal(visible.credentialStatus, "ready")
  assert.equal(visible.modelAssignmentsComplete, false, "expired credential is not removal")
  await db.update(GatewayCredentialSetTable).set({ credential_mode: "member" }).where(eq(GatewayCredentialSetTable.id, missing.set))
  visible = await read()
  assert.equal(visible.modelAssignmentsComplete, true, "member-auth aliases fully represent their assignments")
  assert.equal(list(visible.models).length, 1)
  const authorizationRequests = list(visible.authorizationRequests)
  assert.equal(authorizationRequests.length, 1)
  assert.equal(list(authorizationRequests[0]?.models).length, 1)
  await db.update(GatewayCredentialSetTable).set({ status: "disabled" }).where(eq(GatewayCredentialSetTable.id, missing.set))
  visible = await read()
  assert.equal(visible.modelAssignmentsComplete, true, "explicitly disabled assignment is a real removal")
  assert.equal(list(visible.models).length, 1)
  await db.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.id, link))
  visible = await read()
  assert.equal(visible.modelAssignmentsComplete, true, "removed group link can confirm removal")
  assert.equal(list(visible.models).length, 0)
  await db.update(GatewayProviderCredentialTable).set({ expires_at: new Date(Date.now() - 1_000) }).where(eq(GatewayProviderCredentialTable.id, healthy.credential))
  visible = await read()
  assert.equal(visible.credentialStatus, "org_credential_missing")
  assert.equal(visible.modelAssignmentsComplete, true, "empty assignment set is complete even without credentials")
})
