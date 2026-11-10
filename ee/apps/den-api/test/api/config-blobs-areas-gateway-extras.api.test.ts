/**
 * Config-blob areas `ai-gateway.limits`, `ai-gateway.smart-routers` and
 * `ai-gateway.openwork-models`: export allowlist and references, readItems,
 * minimal writes from the plan's changes, and the export → import → export
 * round trip into a second organization. The engine is not involved: refs are
 * resolved here the way the engine hands them to `apply`.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AutoRouterModelTable, GatewayUsageAssignmentTable, GatewayUsagePolicyTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigFieldChange } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigAreaContext, ConfigItem } from "../../src/config-blobs/area.js"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, isRecord, summary, text, type Member } from "./harness.js"

const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud" } })
after(async () => { restoreFetch(); await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { aiGatewayLimitsArea: limits } = await import("../../src/config-blobs/areas/ai-gateway-limits.js")
const { aiGatewaySmartRoutersArea: routers } = await import("../../src/config-blobs/areas/ai-gateway-smart-routers.js")
const { aiGatewayOpenWorkModelsArea: models } = await import("../../src/config-blobs/areas/ai-gateway-openwork-models.js")

const SECRET = "sk-config-blob-extras-secret-0001"

type Org = { orgId: string; owner: Member; member: Member; teamId: string; providerId: string }

async function context(org: Org): Promise<ConfigAreaContext> {
  return { db, organizationId: org.orgId, actor: { userId: org.owner.userId, memberId: org.owner.memberId }, deployment: "cloud", features: await getOrganizationFeatures(org.orgId) }
}

async function setup(label: string): Promise<Org> {
  const created = await den.createOrg(await den.signUp(`${label} Owner`), `${label} org`)
  const member = await den.newMember(created.owner, created.orgId, `${label} Member`)
  const teamId = await den.createTeam(created.owner, created.orgId, "Platform", [member.memberId])
  const feature = await den.setFeature(created.orgId, "autoRouter", true)
  assert.ok(feature.status < 300, summary(feature))
  const call = den.as(created.owner, created.orgId)
  const provider = await call("POST", "/v1/inference-providers", { name: "Fixture OpenAI", providerId: "openai", modelIds: ["gpt-6-luna", "gpt-fixture-other"] })
  assert.equal(provider.status, 201, summary(provider))
  const providerId = text(field(provider.body, "inferenceProvider", "id"), "provider id")
  const group = await call("POST", `/v1/inference-providers/${providerId}/model-groups`, { name: "All", modelIds: ["gpt-6-luna", "gpt-fixture-other"] })
  assert.equal(group.status, 201, summary(group))
  const set = await call("POST", `/v1/inference-providers/${providerId}/credential-sets`, { name: "Shared", credentialMode: "org", credential: { kind: "api_key", secret: SECRET } })
  assert.equal(set.status, 201, summary(set))
  return { orgId: created.orgId, owner: created.owner, member, teamId, providerId }
}

/** What the engine hands apply: every ref gets the target's local id. */
function resolveSpec(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveSpec(entry, ids))
  if (!isRecord(value)) return value
  if (typeof value.$ref === "string") {
    const id = ids.get(value.$ref)
    assert.ok(id, `unresolved ${value.$ref}`)
    return { ...value, id }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveSpec(entry, ids)]))
}

function refMap(source: Org, target: Org): Map<string, string> {
  return new Map([
    [`ai-gateway.providers/${source.providerId}`, target.providerId],
    [`members.teams/${source.teamId}`, target.teamId],
    [`people/${source.member.email.toLowerCase()}`, target.member.memberId],
  ])
}
function selfRefs(org: Org): Map<string, string> {
  return refMap(org, org)
}

/** Specs compared across orgs: refs keep only their area. */
function portable(spec: unknown): unknown {
  return JSON.parse(JSON.stringify(spec, (key, value: unknown) => {
    if (key === "$ref" && typeof value === "string") return value.startsWith("people/") ? "people/*" : `${value.slice(0, value.indexOf("/"))}/*`
    if (key === "name") return undefined
    return value
  }))
}

async function exportOne(area: ConfigArea, org: Org, id: string): Promise<ConfigItem> {
  const item = (await area.exportItems(await context(org))).find((entry) => entry.id === id)
  assert.ok(item, `${area.key} exported ${id}`)
  return item
}

function asSpec(value: unknown): { [key: string]: unknown } {
  assert.ok(isRecord(value))
  return value
}

const source = await setup("Gateway Extras Source")
const sourceCall = den.as(source.owner, source.orgId)

// A provider limit with two periods, assigned to everyone, the team and the member.
const policy = await sourceCall("POST", "/v1/gateway/usage-limit-policies", {
  name: "Engineering spend", providerId: source.providerId, hardLimit: true, allowRequestReset: false,
  limits: [{ timeframe: "month", costUsd: "200.5" }, { timeframe: "day", costUsd: "20" }],
})
assert.equal(policy.status, 200, summary(policy))
const policyId = text(field(policy.body, "id"), "policy id")
for (const target of [{ organization: true }, { teamId: source.teamId }, { memberId: source.member.memberId }]) {
  const assigned = await sourceCall("POST", `/v1/gateway/usage-limit-policies/${policyId}/assignments`, target)
  assert.equal(assigned.status, 200, summary(assigned))
}

// A Smart Router with two models and tasks, for the team and the member.
const router = await sourceCall("POST", "/v1/org/auto-routers", {
  name: "Smart Engineering",
  models: [
    { providerId: source.providerId, modelId: "gpt-fixture-other", tasks: ["Code review", "Debugging"] },
    { providerId: source.providerId, modelId: "gpt-6-luna", tasks: ["Quick questions"] },
  ],
})
assert.equal(router.status, 200, summary(router))
const routerId = text(field(router.body, "routerId"), "router id")
const assignedRouter = await sourceCall("PUT", `/v1/org/auto-routers/${routerId}/assignment`, { assignment: { everyone: false, teamIds: [source.teamId], memberIds: [source.member.memberId] } })
assert.equal(assignedRouter.status, 200, summary(assignedRouter))

const limitExport = await exportOne(limits, source, policyId)
const routerExport = await exportOne(routers, source, routerId)

test("limits: export carries the policy, provider/team/people refs and USD amounts, nothing runtime", () => {
  assert.equal(limits.specSchema.safeParse(limitExport.spec).success, true)
  assert.equal(limitExport.name, "Engineering spend")
  assert.deepEqual(limitExport.spec, {
    provider: { $ref: `ai-gateway.providers/${source.providerId}`, name: "Fixture OpenAI" },
    hardLimit: true,
    allowRequestReset: false,
    limits: [{ timeframe: "day", costUsd: "20" }, { timeframe: "month", costUsd: "200.5" }],
    assignments: {
      organization: true,
      teams: [{ $ref: `members.teams/${source.teamId}`, name: "Platform" }],
      members: [{ $ref: `people/${source.member.email.toLowerCase()}` }],
    },
  })
  const json = JSON.stringify(limitExport)
  assert.ok(!json.includes(SECRET))
  assert.ok(!/revision|bucket|createdBy/.test(json), "no runtime or row fields")
})

test("smart routers: export carries ordered models with provider refs and tasks, and the audience", () => {
  assert.equal(routers.specSchema.safeParse(routerExport.spec).success, true)
  assert.equal(routerExport.name, "Smart Engineering")
  assert.deepEqual(routerExport.spec, {
    assignment: {
      everyone: false,
      teams: [{ $ref: `members.teams/${source.teamId}`, name: "Platform" }],
      members: [{ $ref: `people/${source.member.email.toLowerCase()}` }],
    },
    models: [
      { provider: { $ref: `ai-gateway.providers/${source.providerId}`, name: "Fixture OpenAI" }, modelId: "gpt-fixture-other", tasks: ["Code review", "Debugging"] },
      { provider: { $ref: `ai-gateway.providers/${source.providerId}`, name: "Fixture OpenAI" }, modelId: "gpt-6-luna", tasks: ["Quick questions"] },
    ],
  })
  assert.ok(!JSON.stringify(routerExport).includes(SECRET))
})

test("openwork models: one settings item, no keys", async () => {
  const items = await models.exportItems(await context(source))
  assert.equal(items.length, 1)
  assert.deepEqual(items[0]?.spec, { autoOffered: true, autoPinned: false })
  assert.equal(items[0]?.id, source.orgId)
})

test("readItems returns only the asked ids", async () => {
  const ctx = await context(source)
  assert.ok(limits.readItems && routers.readItems && models.readItems)
  assert.deepEqual((await limits.readItems(ctx, [policyId, "missing"])).map((item) => item.id), [policyId])
  assert.deepEqual(await limits.readItems(ctx, []), [])
  assert.deepEqual((await routers.readItems(ctx, [routerId, createDenTypeId("autoRouter")])).map((item) => item.id), [routerId])
  assert.deepEqual((await models.readItems(ctx, ["nope"])), [])
  assert.deepEqual(JSON.stringify(await limits.readItems(ctx, [policyId])), JSON.stringify([limitExport]))
})

test("limits: an update writes only the fields its changes name", async () => {
  const ctx = await context(source)
  const before = (await db.select().from(GatewayUsagePolicyTable).where(eq(GatewayUsagePolicyTable.id, policyId)))[0]
  const assignmentsBefore = await db.select({ id: GatewayUsageAssignmentTable.id }).from(GatewayUsageAssignmentTable).where(eq(GatewayUsageAssignmentTable.policyId, policyId))
  // The blob also differs in limits and assignments, but the plan only names hardLimit: nothing else is written.
  const spec = asSpec(resolveSpec(limitExport.spec, selfRefs(source)))
  spec.hardLimit = false
  spec.limits = [{ timeframe: "week", costUsd: "1" }]
  spec.assignments = { organization: false, teams: [], members: [] }
  const changes: ConfigFieldChange[] = [{ path: "hardLimit", from: true, to: false }]
  assert.deepEqual(limits.irreversible?.({ kind: "update", targetId: policyId, previous: limitExport, item: { name: limitExport.name, spec }, changes, secretPaths: [] }).length, 1, "pending requests note")
  const result = await limits.apply(ctx, { kind: "update", targetId: policyId, previous: limitExport, item: { sourceId: policyId, name: limitExport.name, spec }, changes, secretPaths: [] })
  assert.equal(result.localId, policyId)
  assert.deepEqual(result.steps?.map((step) => step.action), ["update"])
  const afterExport = await exportOne(limits, source, policyId)
  assert.deepEqual(afterExport.spec, { ...limitExport.spec, hardLimit: false })
  const after = (await db.select().from(GatewayUsagePolicyTable).where(eq(GatewayUsagePolicyTable.id, policyId)))[0]
  assert.equal(after?.revision, (before?.revision ?? 0) + 1)
  const assignmentsAfter = await db.select({ id: GatewayUsageAssignmentTable.id }).from(GatewayUsageAssignmentTable).where(eq(GatewayUsageAssignmentTable.policyId, policyId))
  assert.deepEqual(assignmentsAfter.map((row) => row.id).sort(), assignmentsBefore.map((row) => row.id).sort(), "assignment rows untouched")

  // An assignment-only change adds/removes just those rows.
  const dropMember = asSpec(resolveSpec(afterExport.spec, selfRefs(source)))
  dropMember.assignments = { ...asSpec(dropMember.assignments), members: [] }
  const removed = await limits.apply(ctx, { kind: "update", targetId: policyId, previous: afterExport, item: { name: afterExport.name, spec: dropMember }, changes: [{ path: "assignments.members", added: [], removed: [{ $ref: `people/${source.member.email.toLowerCase()}` }] }], secretPaths: [] })
  assert.deepEqual(removed.steps?.map((step) => `${step.action} ${step.target}`), ["remove assignments.members"])
  const revisionAfterUnassign = (await db.select().from(GatewayUsagePolicyTable).where(eq(GatewayUsagePolicyTable.id, policyId)))[0]?.revision
  assert.equal(revisionAfterUnassign, after?.revision, "settings not rewritten")
  const restored = asSpec(resolveSpec(limitExport.spec, selfRefs(source)))
  await limits.apply(ctx, { kind: "update", targetId: policyId, previous: await exportOne(limits, source, policyId), item: { name: limitExport.name, spec: restored }, changes: [{ path: "hardLimit" }, { path: "assignments.members" }], secretPaths: [] })
  assert.deepEqual((await exportOne(limits, source, policyId)).spec, limitExport.spec)
})

test("smart routers: a rename writes only the name; models keep their rows", async () => {
  const ctx = await context(source)
  const modelRows = async () => (await db.select({ id: AutoRouterModelTable.id }).from(AutoRouterModelTable).where(eq(AutoRouterModelTable.autoRouterId, routerExport.id))).map((row) => row.id).sort()
  const before = await modelRows()
  const spec = resolveSpec(routerExport.spec, selfRefs(source))
  const result = await routers.apply(ctx, { kind: "update", targetId: routerId, previous: routerExport, item: { name: "Smart Eng", spec }, changes: [{ path: "name", from: "Smart Engineering", to: "Smart Eng" }], secretPaths: [] })
  assert.deepEqual(result.steps?.map((step) => step.detail), ["name"])
  assert.deepEqual(await modelRows(), before, "model rows not rewritten")
  const renamed = await exportOne(routers, source, routerId)
  assert.equal(renamed.name, "Smart Eng")
  assert.deepEqual(renamed.spec, routerExport.spec)

  // A model change replaces the list (and keeps the assignment).
  const reordered = asSpec(resolveSpec(routerExport.spec, selfRefs(source)))
  const list = Array.isArray(reordered.models) ? [...reordered.models] : []
  reordered.models = list.reverse()
  await routers.apply(ctx, { kind: "update", targetId: routerId, previous: renamed, item: { name: "Smart Engineering", spec: reordered }, changes: [{ path: "models" }, { path: "name" }], secretPaths: [] })
  const changed = await exportOne(routers, source, routerId)
  assert.equal(changed.name, "Smart Engineering")
  assert.deepEqual(asSpec(changed.spec).assignment, asSpec(routerExport.spec).assignment)
  assert.deepEqual((Array.isArray(asSpec(changed.spec).models) ? asSpec(changed.spec).models : []), [...(Array.isArray(asSpec(routerExport.spec).models) ? asSpec(routerExport.spec).models : [])].reverse())
  await routers.apply(ctx, { kind: "update", targetId: routerId, previous: changed, item: { name: "Smart Engineering", spec: resolveSpec(routerExport.spec, selfRefs(source)) }, changes: [{ path: "models" }], secretPaths: [] })
  assert.deepEqual((await exportOne(routers, source, routerId)).spec, routerExport.spec)
})

test("round trip into a second organization: refs resolve to its provider, team and people", async () => {
  const target = await setup("Gateway Extras Target")
  const ctx = await context(target)
  const refs = refMap(source, target)

  const limitCreated = await limits.apply(ctx, { kind: "create", item: { sourceId: policyId, name: limitExport.name, spec: resolveSpec(limitExport.spec, refs) }, preferredId: policyId })
  assert.notEqual(limitCreated.localId, policyId, "policy UUIDs are never reused")
  assert.deepEqual(limitCreated.steps?.map((step) => step.action), ["create", "add", "add", "add"])
  const limitTarget = await exportOne(limits, target, limitCreated.localId)
  assert.deepEqual(portable(limitTarget.spec), portable(limitExport.spec))
  assert.equal(field(limitTarget.spec, "provider", "$ref"), `ai-gateway.providers/${target.providerId}`)
  assert.deepEqual(field(limitTarget.spec, "assignments", "members"), [{ $ref: `people/${target.member.email.toLowerCase()}` }])

  const preferredId = createDenTypeId("autoRouter")
  const routerCreated = await routers.apply(ctx, { kind: "create", item: { sourceId: routerId, name: routerExport.name, spec: resolveSpec(routerExport.spec, refs) }, preferredId })
  assert.equal(routerCreated.localId, preferredId, "a free source id is reused")
  const routerTarget = await exportOne(routers, target, preferredId)
  assert.deepEqual(portable(routerTarget.spec), portable(routerExport.spec))
  assert.deepEqual(field(routerTarget.spec, "assignment", "teams"), [{ $ref: `members.teams/${target.teamId}`, name: "Platform" }])

  // A taken preferred id falls back to a new one.
  const again = await routers.apply(ctx, { kind: "create", item: { name: "Copy", spec: resolveSpec(routerExport.spec, refs) }, preferredId })
  assert.notEqual(again.localId, preferredId)

  // A model the target's gateway does not offer fails with the field and no writes.
  const unknown = asSpec(resolveSpec(routerExport.spec, refs))
  unknown.models = [{ provider: { $ref: "ai-gateway.providers/x", id: target.providerId }, modelId: "not-a-model", tasks: ["x"] }]
  await assert.rejects(routers.apply(ctx, { kind: "create", item: { name: "Broken", spec: unknown } }), (error: unknown) => {
    assert.ok(isRecord(error) && isRecord(error.failure))
    assert.equal(error.failure.code, "unknown_model")
    assert.deepEqual(error.stepsDone, [])
    return true
  })

  // Deletes: limits archive, routers delete.
  const archived = await limits.apply(ctx, { kind: "delete", targetId: limitCreated.localId, previous: limitTarget })
  assert.deepEqual(archived.steps?.map((step) => step.detail), ["archived"])
  assert.equal((await limits.exportItems(ctx)).length, 0)
  assert.ok(routers.irreversible?.({ kind: "delete", targetId: again.localId, previous: routerTarget }).length)
  await routers.apply(ctx, { kind: "delete", targetId: again.localId, previous: routerTarget })
  assert.deepEqual((await routers.exportItems(ctx)).map((item) => item.id), [preferredId])
})

test("openwork models: changing the Auto pin writes only the pin", async () => {
  const ctx = await context(source)
  const [item] = await models.exportItems(ctx)
  assert.ok(item)
  const result = await models.apply(ctx, { kind: "update", targetId: item.id, previous: item, item: { name: item.name, spec: { autoOffered: true, autoPinned: true } }, changes: [{ path: "autoPinned", from: false, to: true }], secretPaths: [] })
  assert.deepEqual(result.steps?.map((step) => step.target), ["autoPinned"])
  const [org] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", item.id)))
  assert.equal(field(org?.metadata, "inferenceFree", "defaultPinned"), true)
  assert.deepEqual((await models.exportItems(ctx))[0]?.spec, { autoOffered: true, autoPinned: true })
  assert.equal(models.irreversible?.({ kind: "update", targetId: item.id, previous: item, item: { name: item.name, spec: { autoOffered: false, autoPinned: true } }, changes: [{ path: "autoOffered" }], secretPaths: [] }).length, 1)
  await assert.rejects(models.apply(ctx, { kind: "delete", targetId: item.id, previous: item }))
})
