import assert from "node:assert/strict"
import { after, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, GatewayCredentialSetTable, GatewayKeyTable, GatewayModelGroupModelTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { sessionTokenDigest } from "../../src/session-token.js"
import { bootDen, field, list, summary, text } from "./harness.js"

// The harness creates and drops its own database; no existing organization is
// read or written. Matrix rows are arranged directly to avoid upstream catalog
// and credential verification services in this dependency-boundary test.
const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { readProviderInventoryRevision } = await import("../../src/llm/provider-inventory.js")

test("inventory fingerprints only effective caller grants, including SSE and expired-session fencing", { timeout: 30_000 }, async () => {
  const a = await den.createOrg(await den.signUp("Inventory Owner"), "Inventory fixture")
  const member = await den.newMember(a.owner, a.orgId, "Inventory Member")
  const other = await den.newMember(a.owner, a.orgId, "Other Inventory Member")
  const b = await den.createOrg(await den.signUp("Other Inventory Owner"), "Other inventory fixture")
  const [membership] = await db.select().from(MemberTable).where(eq(MemberTable.id, normalizeDenTypeId("member", member.memberId)))
  const [otherMembership] = await db.select().from(MemberTable).where(eq(MemberTable.id, normalizeDenTypeId("member", other.memberId)))
  const [otherOrgMembership] = await db.select().from(MemberTable).where(eq(MemberTable.id, normalizeDenTypeId("member", b.owner.memberId)))
  const [session] = await db.select().from(AuthSessionTable).where(eq(AuthSessionTable.token, sessionTokenDigest(member.token)))
  assert.ok(membership?.userId && otherMembership && otherOrgMembership && session)
  const principal = { organizationId: membership.organizationId, memberId: membership.id, userId: membership.userId, sessionId: session.id, sessionToken: member.token }
  const revision = () => readProviderInventoryRevision(principal)
  const apiRevision = async () => {
    const response = await den.as(member, a.orgId)("GET", "/v1/inference-providers/inventory/revision")
    assert.equal(response.status, 200, summary(response))
    return text(field(response.body, "revision"), "inventory revision")
  }
  async function seed(owner: typeof membership, name: string) {
    const provider = createDenTypeId("inferenceProvider")
    const model = createDenTypeId("inferenceProviderModel")
    const group = createDenTypeId("gatewayModelGroup")
    const set = createDenTypeId("gatewayCredentialSet")
    const credential = createDenTypeId("inferenceProviderCredential")
    await db.insert(GatewayProviderTable).values({ id: provider, organization_id: owner.organizationId, created_by_org_membership_id: owner.id, provider_id: "openai", name, provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }, settings: {} })
    await db.insert(GatewayProviderModelTable).values({ id: model, gateway_provider_id: provider, model_id: "fixture-model", name: "Fixture model", model_config: { limit: { context: 100_000 }, cost: { input: 1 } } })
    await db.insert(GatewayModelGroupTable).values({ id: group, gateway_provider_id: provider, name: "Granted models" })
    await db.insert(GatewayModelGroupModelTable).values({ id: createDenTypeId("gatewayModelGroupModel"), model_group_id: group, gateway_provider_model_id: model })
    await db.insert(GatewayCredentialSetTable).values({ id: set, gateway_provider_id: provider, name: "Shared key", credential_mode: "org" })
    await db.insert(GatewayProviderCredentialTable).values({ id: credential, organization_id: owner.organizationId, gateway_provider_id: provider, credential_set_id: set, subject: "org", kind: "api_key", secret: "fixture-upstream-key" })
    return { provider, model, group, set, credential }
  }
  const visible = await seed(membership, "Visible provider")
  const hidden = await seed(membership, "Hidden provider")
  const crossOrg = await seed(otherOrgMembership, "Other org provider")
  const ownGrant = { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: visible.provider, model_group_id: visible.group, credential_set_id: visible.set, audience_key: `member:${membership.id}`, org_membership_id: membership.id }
  await db.insert(GatewayProviderAccessTable).values(ownGrant)
  const baseline = await apiRevision()
  assert.equal(await revision(), baseline)

  const controller = new AbortController()
  const stream = await den.app.request("http://127.0.0.1:8790/v1/inference-providers/inventory/events", { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": a.orgId }, signal: controller.signal })
  assert.equal(stream.status, 200)
  const reader = stream.body!.getReader()
  const decode = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk)
  assert.equal(decode((await reader.read()).value), `event: inventory.changed\ndata: {"revision":"${baseline}"}\n\n`)
  let nextDelivered = false
  const next = reader.read().then((value) => { nextDelivered = true; return value })
  async function unchanged(label: string, mutate: () => Promise<unknown>) {
    await mutate()
    assert.equal(await revision(), baseline, label)
  }
  await unchanged("inaccessible provider metadata", () => db.update(GatewayProviderTable).set({ name: "Hidden rename", updated_at: new Date() }).where(eq(GatewayProviderTable.id, hidden.provider)))
  await unchanged("inaccessible provider models", () => db.update(GatewayProviderModelTable).set({ name: "Hidden model rename" }).where(eq(GatewayProviderModelTable.id, hidden.model)))
  await unchanged("orphan provider insertion", () => seed(membership, "New ungranted provider"))
  await unchanged("other organization", () => db.update(GatewayProviderTable).set({ name: "Cross org rename" }).where(eq(GatewayProviderTable.id, crossOrg.provider)))
  const hiddenModel = createDenTypeId("inferenceProviderModel")
  await unchanged("ungranted model on granted provider", () => db.insert(GatewayProviderModelTable).values({ id: hiddenModel, gateway_provider_id: visible.provider, model_id: "ungranted-model", name: "Ungranted", model_config: {} }))
  await unchanged("ungranted model metadata and provider touch", async () => {
    await db.update(GatewayProviderModelTable).set({ model_config: { limit: { context: 2 } } }).where(eq(GatewayProviderModelTable.id, hiddenModel))
    await db.update(GatewayProviderTable).set({ updated_at: new Date(), pinned_model_ids: ["ungranted-model"] }).where(eq(GatewayProviderTable.id, visible.provider))
  })
  await unchanged("other member access", () => db.insert(GatewayProviderAccessTable).values({ id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: hidden.provider, model_group_id: hidden.group, credential_set_id: hidden.set, audience_key: `member:${otherMembership.id}`, org_membership_id: otherMembership.id }))
  await unchanged("other member credential", () => db.insert(GatewayProviderCredentialTable).values({ id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: visible.provider, credential_set_id: visible.set, organization_id: membership.organizationId, subject: otherMembership.id, org_membership_id: otherMembership.id, kind: "api_key", secret: "someone-elses-key" }))
  const privateGroup = createDenTypeId("gatewayModelGroup")
  const privateSet = createDenTypeId("gatewayCredentialSet")
  const privateLink = createDenTypeId("gatewayModelGroupModel")
  await unchanged("other member group/set/grant on otherwise accessible provider", async () => {
    await db.insert(GatewayModelGroupTable).values({ id: privateGroup, gateway_provider_id: visible.provider, name: "Private group" })
    await db.insert(GatewayCredentialSetTable).values({ id: privateSet, gateway_provider_id: visible.provider, name: "Private credentials", credential_mode: "member" })
    await db.insert(GatewayModelGroupModelTable).values({ id: privateLink, model_group_id: privateGroup, gateway_provider_model_id: hiddenModel })
    await db.insert(GatewayProviderAccessTable).values({ id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: visible.provider, model_group_id: privateGroup, credential_set_id: privateSet, org_membership_id: otherMembership.id, audience_key: `member:${otherMembership.id}` })
  })
  await unchanged("private group/model/set edits and incidental provider timestamp", async () => {
    await db.update(GatewayModelGroupTable).set({ name: "Private group renamed" }).where(eq(GatewayModelGroupTable.id, privateGroup))
    await db.update(GatewayCredentialSetTable).set({ name: "Private set renamed" }).where(eq(GatewayCredentialSetTable.id, privateSet))
    await db.update(GatewayProviderModelTable).set({ name: "Private model renamed", model_config: { cost: { input: 77 } } }).where(eq(GatewayProviderModelTable.id, hiddenModel))
    await db.update(GatewayProviderTable).set({ updated_at: new Date(Date.now() + 10_000) }).where(eq(GatewayProviderTable.id, visible.provider))
  })
  const privateCredential = createDenTypeId("inferenceProviderCredential")
  await unchanged("other member's granted credential creation", () => db.insert(GatewayProviderCredentialTable).values({ id: privateCredential, gateway_provider_id: visible.provider, credential_set_id: privateSet, organization_id: membership.organizationId, subject: otherMembership.id, org_membership_id: otherMembership.id, kind: "api_key", secret: "private-member-key" }))
  await unchanged("other member's key rotation and expiry", () => db.update(GatewayProviderCredentialTable).set({ secret: "rotated-private-member-key", expires_at: new Date(Date.now() - 1_000) }).where(eq(GatewayProviderCredentialTable.id, privateCredential)))
  await unchanged("private group link deletion", () => db.delete(GatewayModelGroupModelTable).where(eq(GatewayModelGroupModelTable.id, privateLink)))
  const unrelatedTeam = createDenTypeId("team")
  await unchanged("unrelated own team membership", async () => {
    await db.insert(TeamTable).values({ id: unrelatedTeam, name: "Unrelated team", organizationId: membership.organizationId })
    await db.insert(TeamMemberTable).values({ id: createDenTypeId("teamMember"), teamId: unrelatedTeam, orgMembershipId: membership.id })
  })
  await unchanged("inaccessible provider deletion", () => db.delete(GatewayProviderTable).where(eq(GatewayProviderTable.id, hidden.provider)))
  await delay(2_200)
  assert.equal(nextDelivered, false, "unrelated mutations emit no SSE change")

  await db.update(GatewayProviderModelTable).set({ model_config: { limit: { context: 200_000 }, cost: { input: 2 } } }).where(eq(GatewayProviderModelTable.id, visible.model))
  const metadataRevision = await apiRevision()
  assert.notEqual(metadataRevision, baseline)
  assert.equal(decode((await next).value), `event: inventory.changed\ndata: {"revision":"${metadataRevision}"}\n\n`)
  await reader.cancel()
  controller.abort()

  async function changed(label: string, mutate: () => Promise<unknown>) {
    const before = await revision()
    await mutate()
    assert.notEqual(await revision(), before, label)
  }
  await changed("group name", () => db.update(GatewayModelGroupTable).set({ name: "New public group name" }).where(eq(GatewayModelGroupTable.id, visible.group)))
  await changed("credential set name", () => db.update(GatewayCredentialSetTable).set({ name: "New public set name" }).where(eq(GatewayCredentialSetTable.id, visible.set)))
  await changed("shared credential rotation", () => db.update(GatewayProviderCredentialTable).set({ secret: "rotated-fixture-key" }).where(eq(GatewayProviderCredentialTable.id, visible.credential)))
  await changed("credential expiry", () => db.update(GatewayProviderCredentialTable).set({ expires_at: new Date(Date.now() - 1_000) }).where(eq(GatewayProviderCredentialTable.id, visible.credential)))
  const keyId = createDenTypeId("gatewayKey")
  await changed("caller gateway key deletion", () => db.delete(GatewayKeyTable).where(and(eq(GatewayKeyTable.organization_id, membership.organizationId), eq(GatewayKeyTable.org_membership_id, membership.id))))
  await changed("caller gateway key creation", () => db.insert(GatewayKeyTable).values({ id: keyId, organization_id: membership.organizationId, org_membership_id: membership.id, encrypted_key: "fixture-gateway-key", key_hash: "a".repeat(64), key_prefix: "fixture" }))
  await changed("caller gateway key rotation", () => db.update(GatewayKeyTable).set({ encrypted_key: "rotated-gateway-key" }).where(eq(GatewayKeyTable.id, keyId)))
  const siblingModel = createDenTypeId("inferenceProviderModel")
  const siblingGroup = createDenTypeId("gatewayModelGroup")
  await changed("independent sibling grant", async () => {
    await db.insert(GatewayProviderModelTable).values({ id: siblingModel, gateway_provider_id: visible.provider, model_id: "sibling-model", name: "Sibling model", model_config: { limit: { context: 300_000 } } })
    await db.insert(GatewayModelGroupTable).values({ id: siblingGroup, gateway_provider_id: visible.provider, name: "Sibling group" })
    await db.insert(GatewayModelGroupModelTable).values({ id: createDenTypeId("gatewayModelGroupModel"), model_group_id: siblingGroup, gateway_provider_model_id: siblingModel })
    await db.insert(GatewayProviderAccessTable).values({ ...ownGrant, id: createDenTypeId("inferenceProviderAccess"), model_group_id: siblingGroup })
    await db.update(GatewayProviderCredentialTable).set({ expires_at: null }).where(eq(GatewayProviderCredentialTable.id, visible.credential))
  })
  await changed("direct access revoke", () => db.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, ownGrant.id)))
  const retained = await den.as(member, a.orgId)("GET", `/v1/inference-providers/${visible.provider}/connect`)
  assert.equal(retained.status, 200, summary(retained))
  assert.deepEqual(list(field(retained.body, "inferenceProvider", "models")).map((model) => model.upstreamModelId), ["sibling-model"], "revocation removes only that grant's model and keeps the independent sibling")
  assert.ok(!retained.text.includes("Private group renamed") && !retained.text.includes("Private model renamed"), "other member group/model never appears in caller connect payload")
  await changed("direct access regrant", () => db.insert(GatewayProviderAccessTable).values(ownGrant))
  await db.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, ownGrant.id))
  const teamGrant = { ...ownGrant, id: createDenTypeId("inferenceProviderAccess"), org_membership_id: null, team_id: unrelatedTeam, audience_key: `team:${unrelatedTeam}` }
  await changed("team grant", () => db.insert(GatewayProviderAccessTable).values(teamGrant))
  await changed("team membership revoke", () => db.delete(TeamMemberTable).where(and(eq(TeamMemberTable.teamId, unrelatedTeam), eq(TeamMemberTable.orgMembershipId, membership.id))))
  await changed("team membership regrant", () => db.insert(TeamMemberTable).values({ id: createDenTypeId("teamMember"), teamId: unrelatedTeam, orgMembershipId: membership.id }))
  await changed("team grant revoke", () => db.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.id, teamGrant.id)))
  await changed("team grant regrant", () => db.insert(GatewayProviderAccessTable).values(teamGrant))
  await changed("model deletion", () => db.delete(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.id, visible.model)))
  await changed("provider disable", () => db.update(GatewayProviderTable).set({ status: "disabled" }).where(eq(GatewayProviderTable.id, visible.provider)))
  await changed("provider re-enable", () => db.update(GatewayProviderTable).set({ status: "active" }).where(eq(GatewayProviderTable.id, visible.provider)))

  const expiredStream = await den.app.request("http://127.0.0.1:8790/v1/inference-providers/inventory/events", { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": a.orgId } })
  const expiredReader = expiredStream.body!.getReader()
  await expiredReader.read()
  await db.update(AuthSessionTable).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(AuthSessionTable.id, session.id))
  await assert.rejects(revision(), /no longer authorized/)
  assert.equal((await expiredReader.read()).done, true, "existing SSE closes on expired DB session")
  const expired = await den.as(member, a.orgId)("GET", "/v1/inference-providers/inventory/revision")
  assert.notEqual(expired.status, 200, "expired session cannot read a new revision")
})
