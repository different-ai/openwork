/**
 * Deleting an AI Gateway provider never silently orphans the usage limits scoped to it: the admin moves them to
 * another provider of the organization or archives them, and limits orphaned before this rule show as removed.
 * Behind gatewayProviderRemovalLimits; with it off the delete behaves exactly as before.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { GatewayUsageLimitTable, GatewayUsagePolicyTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: gatewayFixtureEnv })
const restoreCatalog = stubPublicModelCatalog()
after(async () => { restoreCatalog(); await den.close() })
const { db } = await import("../../src/db.js")

const policiesPath = "/v1/gateway/usage-limit-policies"

async function createProvider(owner: Member, orgId: string, name: string): Promise<string> {
  const created = await den.as(owner, orgId)("POST", "/v1/inference-providers", { name, providerId: "openai", modelIds: ["gpt-6-luna"] })
  assert.equal(created.status, 201, summary(created))
  return text(field(created.body, "inferenceProvider", "id"), "provider id")
}

async function createProviderLimit(owner: Member, orgId: string, providerId: string, name: string, teamId: string): Promise<string> {
  const call = den.as(owner, orgId)
  const created = await call("POST", policiesPath, { name, providerId, hardLimit: true, limits: [{ timeframe: "month", costUsd: "4000" }] })
  assert.equal(created.status, 200, summary(created))
  const policyId = text(field(created.body, "id"), "policy id")
  const assigned = await call("POST", `${policiesPath}/${policyId}/assignments`, { teamId })
  assert.equal(assigned.status, 200, summary(assigned))
  return policyId
}

async function readPolicy(owner: Member, orgId: string, policyId: string) {
  const listed = await den.as(owner, orgId)("GET", policiesPath)
  assert.equal(listed.status, 200, summary(listed))
  const policy = list(field(listed.body, "policies")).find((entry) => entry.id === policyId)
  assert.ok(policy, `policy ${policyId} listed`)
  return policy
}

async function providerExists(owner: Member, orgId: string, providerId: string): Promise<boolean> {
  const read = await den.as(owner, orgId)("GET", `/v1/inference-providers/${providerId}`)
  return read.status === 200
}

const org = await den.createOrg(await den.signUp("Acme Gateway Owner"), "Acme gateway limits")
const teammate = await den.newMember(org.owner, org.orgId, "Acme Teammate")
const teamId = await den.createTeam(org.owner, org.orgId, "Acme research", [teammate.memberId])
const other = await den.createOrg(await den.signUp("Other Gateway Owner"), "Other gateway org")
assert.equal((await den.setFeature(org.orgId, "gatewayProviderRemovalLimits", true)).status, 200)

test("deleting a provider with usage limits and no choice changes nothing and lists the limits", { timeout: 60_000 }, async () => {
  const providerId = await createProvider(org.owner, org.orgId, "Acme OpenRouter old")
  const policyId = await createProviderLimit(org.owner, org.orgId, providerId, "Research monthly cap", teamId)

  const rejected = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${providerId}`)
  assert.equal(rejected.status, 409, summary(rejected))
  assert.equal(field(rejected.body, "error"), "provider_has_usage_limits")
  const limits = list(field(rejected.body, "usageLimits"))
  assert.deepEqual(limits.map((limit) => [limit.id, limit.name, limit.hardLimit]), [[policyId, "Research monthly cap", true]])
  assert.deepEqual(limits[0]?.limits, [{ timeframe: "month", costLimitMicroUsd: 4_000_000_000 }])

  assert.equal(await providerExists(org.owner, org.orgId, providerId), true, "the provider is still there")
  const policy = await readPolicy(org.owner, org.orgId, policyId)
  assert.equal(policy.providerId, providerId)
  assert.equal(policy.providerStatus, "available")
  assert.equal(policy.archivedAt, null)

  const incomplete = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${providerId}?usageLimits=move`)
  assert.equal(incomplete.status, 400, `move needs a target: ${summary(incomplete)}`)
})

test("moving the limits re-scopes them to the new provider before the old one is deleted", { timeout: 60_000 }, async () => {
  const oldProvider = await createProvider(org.owner, org.orgId, "Acme OpenRouter bad key")
  const newProvider = await createProvider(org.owner, org.orgId, "Acme OpenRouter")
  const policyId = await createProviderLimit(org.owner, org.orgId, oldProvider, "Research OpenRouter cap", teamId)
  const before = await readPolicy(org.owner, org.orgId, policyId)

  const moved = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${oldProvider}?usageLimits=move&moveUsageLimitsTo=${newProvider}`)
  assert.equal(moved.status, 204, summary(moved))

  assert.equal(await providerExists(org.owner, org.orgId, oldProvider), false)
  const policy = await readPolicy(org.owner, org.orgId, policyId)
  assert.equal(policy.providerId, newProvider)
  assert.equal(policy.providerStatus, "available")
  assert.equal(policy.archivedAt, null)
  assert.equal(policy.revision, Number(before.revision) + 1, "moving is a policy revision")
  assert.deepEqual(list(policy.assignments).map((assignment) => assignment.teamId), [teamId], "who it applies to is kept")

  const usage = await den.as(org.owner, org.orgId)("GET", `/v1/gateway/usage-limits/members/${teammate.memberId}`)
  assert.equal(usage.status, 200, summary(usage))
  const governed = list(field(usage.body, "providers")).map((entry) => entry.providerId)
  assert.ok(governed.includes(newProvider), "the teammate's requests to the new provider are capped")
  assert.ok(!governed.includes(oldProvider))
})

test("archiving the limits deletes the provider and keeps the limits restorable", { timeout: 60_000 }, async () => {
  const providerId = await createProvider(org.owner, org.orgId, "Acme Anthropic")
  const policyId = await createProviderLimit(org.owner, org.orgId, providerId, "Research Anthropic cap", teamId)

  const archived = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${providerId}?usageLimits=archive`)
  assert.equal(archived.status, 204, summary(archived))

  assert.equal(await providerExists(org.owner, org.orgId, providerId), false)
  const policy = await readPolicy(org.owner, org.orgId, policyId)
  assert.equal(typeof policy.archivedAt, "string", "the limit is archived, not left active")
  assert.equal(policy.providerStatus, "removed")
})

test("limits cannot move to another organization's provider", { timeout: 60_000 }, async () => {
  const providerId = await createProvider(org.owner, org.orgId, "Acme Mistral")
  const foreignProvider = await createProvider(other.owner, other.orgId, "Other org provider")
  const policyId = await createProviderLimit(org.owner, org.orgId, providerId, "Research Mistral cap", teamId)

  const rejected = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${providerId}?usageLimits=move&moveUsageLimitsTo=${foreignProvider}`)
  assert.equal(rejected.status, 404, summary(rejected))
  assert.equal(field(rejected.body, "error"), "usage_limit_provider_not_found")
  const self = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${providerId}?usageLimits=move&moveUsageLimitsTo=${providerId}`)
  assert.equal(self.status, 400, summary(self))

  assert.equal(await providerExists(org.owner, org.orgId, providerId), true, "nothing was deleted")
  assert.equal((await readPolicy(org.owner, org.orgId, policyId)).providerId, providerId)
  assert.equal(await providerExists(other.owner, other.orgId, foreignProvider), true)
})

test("a provider without usage limits still deletes without a choice", { timeout: 60_000 }, async () => {
  const providerId = await createProvider(org.owner, org.orgId, "Acme Groq")
  const deleted = await den.as(org.owner, org.orgId)("DELETE", `/v1/inference-providers/${providerId}`)
  assert.equal(deleted.status, 204, summary(deleted))
})

test("limits orphaned before this rule are listed as provider removed", { timeout: 60_000 }, async () => {
  // Arrange the state production already has: an active limit whose provider row is gone.
  const orphanId = randomUUID()
  const now = new Date()
  await db.insert(GatewayUsagePolicyTable).values({
    id: orphanId, organizationId: normalizeDenTypeId("organization", org.orgId), name: "Orphaned cap",
    inferenceProviderId: createDenTypeId("inferenceProvider"), createdAt: now, updatedAt: now,
    createdBy: normalizeDenTypeId("member", org.owner.memberId),
  })
  await db.insert(GatewayUsageLimitTable).values({ policyId: orphanId, timeframe: "month", costLimitMicroUsd: 4_000_000_000 })
  const defaultLimit = await den.as(org.owner, org.orgId)("POST", policiesPath, { name: "Everyone default", limits: [{ timeframe: "day", costUsd: "20" }] })
  assert.equal(defaultLimit.status, 200, summary(defaultLimit))

  const orphan = await readPolicy(org.owner, org.orgId, orphanId)
  assert.equal(orphan.providerStatus, "removed")
  assert.equal(orphan.archivedAt, null)
  const fallback = await readPolicy(org.owner, org.orgId, text(field(defaultLimit.body, "id"), "default policy id"))
  assert.equal(fallback.providerStatus, null, "default limits have no provider status")

  // The existing edit flow points the orphan at a live provider.
  const providerId = await createProvider(org.owner, org.orgId, "Acme OpenRouter replacement")
  const fixed = await den.as(org.owner, org.orgId)("PATCH", `${policiesPath}/${orphanId}`, {
    name: "Orphaned cap", providerId, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "4000" }], revision: orphan.revision,
  })
  assert.equal(fixed.status, 200, summary(fixed))
  assert.equal(field(fixed.body, "providerStatus"), "available")
})

test("with the feature off, deleting a provider ignores its limits exactly as before", { timeout: 60_000 }, async () => {
  const legacy = await den.createOrg(await den.signUp("Legacy Gateway Owner"), "Acme legacy gateway")
  assert.equal((await den.setFeature(legacy.orgId, "gatewayProviderRemovalLimits", false)).status, 200)
  const legacyTeammate = await den.newMember(legacy.owner, legacy.orgId, "Legacy Teammate")
  const legacyTeam = await den.createTeam(legacy.owner, legacy.orgId, "Acme legacy team", [legacyTeammate.memberId])
  const providerId = await createProvider(legacy.owner, legacy.orgId, "Acme legacy OpenRouter")
  const target = await createProvider(legacy.owner, legacy.orgId, "Acme legacy replacement")
  const policyId = await createProviderLimit(legacy.owner, legacy.orgId, providerId, "Legacy monthly cap", legacyTeam)

  // A choice is ignored too: nothing about the limits changes while the feature is off.
  const deleted = await den.as(legacy.owner, legacy.orgId)("DELETE", `/v1/inference-providers/${providerId}?usageLimits=move&moveUsageLimitsTo=${target}`)
  assert.equal(deleted.status, 204, summary(deleted))
  assert.equal(await providerExists(legacy.owner, legacy.orgId, providerId), false)
  const policy = await readPolicy(legacy.owner, legacy.orgId, policyId)
  assert.equal(policy.providerId, providerId, "the limit is left as it was")
  assert.equal(policy.archivedAt, null)
  assert.equal(policy.providerStatus, "removed", "the list still reports the orphan")

  const plain = await createProvider(legacy.owner, legacy.orgId, "Acme legacy second")
  await createProviderLimit(legacy.owner, legacy.orgId, plain, "Legacy second cap", legacyTeam)
  const noChoice = await den.as(legacy.owner, legacy.orgId)("DELETE", `/v1/inference-providers/${plain}`)
  assert.equal(noChoice.status, 204, `no 409 while the feature is off: ${summary(noChoice)}`)
})
