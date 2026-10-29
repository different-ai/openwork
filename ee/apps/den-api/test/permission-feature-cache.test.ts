import assert from "node:assert/strict"
import { afterEach, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/permission_cache_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-permission-cache-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-permission-cache-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
process.env.DEN_DEPLOYMENT = "self_hosted"
process.env.DEN_FEATURE_PERMISSIONS = "false"
process.env.DEN_FEATURE_SHARED_ROLES = "false"
process.env.DEN_FEATURE_GATEWAY_PROVIDER_USAGE_LIMITS = "false"
const { db } = await import("../src/db.js")
const { cache, setCacheDependenciesForTest } = await import("../src/cache.js")
const { getOrganizationFeatures, getFeaturesForOrganizations, readOrganizationForAuthorization } = await import("../src/features.js")
const { createMemberPermissions } = await import("../src/permissions/effective.ts")
const { decideAdminTeamChange, decideMemberRemoval } = await import("../src/permissions/role-assignment.ts")
const { gatewayProviderUsageLimitsEnabled } = await import("@openwork-ee/den-db/gateway-usage-limits")

const organizationId = createDenTypeId("organization")
const retired = [
  "agentPermissions", "appBuildProgress", "backgroundShellTasks", "desktopPolicyScreenRemoval",
  "gatewayProviderUsageLimits", "googleDocumentTools", "inviteLinkVerifiesEmail", "lastTurnModelFooter",
  "mcpSkillsExtension", "memberListToolbars", "modelRemovalRecovery", "nativeCloudSkills", "orgDefaultModel",
  "permissions", "rememberLastOrganization", "sharedRoles", "slackWorkbotReplies", "teamAccessRows",
  "teamMembershipCache", "teamPageTabs", "teamRoles", "workbot", "workbotLunaDefault",
]
afterEach(() => mock.restoreAll())

test("self-hosted feature maps ignore stale retired off overrides and kill switches in Redis", async () => {
  const values = new Map([
    ["cache:features:generation:deployment", "old"],
    ["cache:features:rollouts:old", JSON.stringify(Object.fromEntries(retired.map(key => [key, { enabled: false, killed: true }])))],
    [`cache:features:overrides:old:${organizationId}`, JSON.stringify(Object.fromEntries(retired.map(key => [key, false])))],
  ])
  const restore = setCacheDependenciesForTest({ redis: {
    async get(key: string) { return values.get(key) ?? null },
    async set(key: string, value: string) { values.set(key, value) },
    async del(...keys: string[]) { keys.forEach(key => values.delete(key)) },
  } })
  try {
    const read = mock.method(db, "select", () => { throw new Error("retired permission rollout must not be read") })
    const features = await getOrganizationFeatures(organizationId)
    for (const key of retired) assert.equal(key in features, false, key)
    assert.equal(features.managedDeployments, false, "cloud-only managed deployments remain disabled")
    assert.equal(read.mock.callCount(), 0)
  } finally { restore() }
})

test("batched maps ignore retired database overrides too", async () => {
  mock.method(cache.features, "rollouts", async () => ({}))
  mock.method(db, "select", () => ({ from: () => ({ where: async () => retired.map(feature_key => ({ organization_id: organizationId, feature_key, enabled: false })) }) }))
  const features = (await getFeaturesForOrganizations([organizationId])).get(organizationId)
  assert.ok(features)
  for (const key of retired) assert.equal(key in features, false, key)
})

test("organization authorization reads no longer join rollout state", async () => {
  const read = mock.method(db, "select", () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: organizationId }] }) }) }))
  const result = await readOrganizationForAuthorization(organizationId)
  assert.equal(result?.organization.id, organizationId)
  assert.equal(read.mock.callCount(), 1)
  assert.deepEqual(read.mock.calls[0].arguments, [])
})

test("provider usage limits ignore retired operator locks and never query rollout state", async () => {
  mock.method(db, "select", () => { throw new Error("retired provider rollout must not be read") })
  assert.equal(await gatewayProviderUsageLimitsEnabled(db, organizationId), true)
})

test("permission safety rules always apply and report the enabled compatibility field", () => {
  const actor = createMemberPermissions({ isOwner: false, isAdmin: false, keys: ["members.delete", "teams.manage_admin"] })
  assert.equal(actor.featureEnabled, true, "compatibility fields always report permissions enabled")
  assert.equal(decideMemberRemoval({ actor, targetIsDirectAdmin: true, targetIsAdminViaTeam: false, targetIsPendingInvitation: false })?.reason, "admin_removal_requires_admin")
  assert.equal(decideAdminTeamChange({ actor, makesAdminTeam: true })?.reason, "admin_team_requires_admin")
})
