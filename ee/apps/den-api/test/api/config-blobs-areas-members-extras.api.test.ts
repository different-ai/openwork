/**
 * Config-blob areas on a team's tabs: `members.agent-permissions`,
 * `members.default-models` and `members.prompts`. Seeded through the public
 * API; adapters are called directly with refs resolved the way the engine
 * hands them to `apply`.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AgentPermissionSettingTable, OrgPromptAccessTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigFieldChange } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigAreaContext, ConfigItem } from "../../src/config-blobs/area.js"
import { bootDen, field, isRecord, summary, text, type Call, type Member } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { membersAgentPermissionsArea } = await import("../../src/config-blobs/areas/members-agent-permissions.js")
const { membersDefaultModelsArea } = await import("../../src/config-blobs/areas/members-default-models.js")
const { membersPromptsArea } = await import("../../src/config-blobs/areas/members-prompts.js")
const { ConfigApplyItemError } = await import("../../src/config-blobs/area.js")

const AREAS: ConfigArea[] = [membersAgentPermissionsArea, membersDefaultModelsArea, membersPromptsArea]

async function contextFor(orgId: string, actor: Member): Promise<ConfigAreaContext> {
  return {
    db,
    organizationId: orgId,
    actor: { userId: actor.userId, memberId: actor.memberId },
    deployment: "self_hosted",
    features: await getOrganizationFeatures(orgId, { userId: actor.userId }),
  }
}

async function ok(call: Promise<Call>, label: string) {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

/** Refs with the local id added (`ids`: source target → local id; people by email). */
function resolveRefs(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, ids))
  if (!isRecord(value)) return value
  if (typeof value.$ref === "string") {
    const target = value.$ref.slice(value.$ref.indexOf("/") + 1)
    const id = ids.get(target)
    assert.ok(id, `unresolved ${value.$ref}`)
    return { ...value, id }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, ids)]))
}

function resolvedItem(item: ConfigItem, ids: Map<string, string>) {
  const spec = resolveRefs(item.spec, ids)
  assert.ok(isRecord(spec))
  return { sourceId: item.id, key: item.key ?? null, name: item.name, spec }
}

/** Specs compared across orgs: refs without their ids. */
function portable(spec: unknown): unknown {
  return JSON.parse(JSON.stringify(spec, (key, value: unknown) => (key === "$ref" && typeof value === "string" ? value.slice(0, value.indexOf("/")) : value)))
}

async function byokProvider(api: ReturnType<typeof den.as>, name: string) {
  const created = await ok(api("POST", "/v1/llm-providers", {
    name,
    source: "custom",
    customConfig: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai-compatible",
      env: ["ACME_API_KEY"],
      api: "https://llm.example.test/v1",
      models: [{ id: "acme-1", name: "Acme One" }, { id: "acme-2", name: "Acme Two" }],
    },
    apiKey: "sk-extras-fixture",
  }), "create provider")
  const providerId = text(field(created.body, "llmProvider", "id"), "provider id")
  const options = await ok(api("GET", "/v1/org/default-model/options"), "options")
  const list = field(options.body, "options")
  const models = Array.isArray(list) ? list.filter(isRecord).filter((option) => option.providerId === providerId).map((option) => String(option.modelId)) : []
  assert.ok(models.length >= 2, `provider models: ${JSON.stringify(options.body)}`)
  return { providerId, models: models.sort() }
}

// ---------------------------------------------------------------------------
// Source organization.

const owner = await den.signUp("Extras Owner")
const source = await den.createOrg(owner, "Extras Source")
const person = await den.newMember(owner, source.orgId, "Extras Person")
const apiA = den.as(owner, source.orgId)
const platformA = await den.createTeam(owner, source.orgId, "Platform", [person.memberId])
const providerA = await byokProvider(apiA, "Acme LLM")

await ok(apiA("PUT", "/v1/agent-permissions/everyone", { settings: {
  commands: { decision: "ask", allow: ["npm test *"], block: ["rm -rf *"] },
  fileEdits: { decision: "allow" },
  webSearch: { decision: "deny" },
} }), "everyone permissions")
await ok(apiA("PUT", `/v1/agent-permissions/teams/${platformA}`, { settings: { websites: { decision: "deny", allow: ["docs.example.com"] } } }), "team permissions")
await ok(apiA("PUT", "/v1/org/default-model/everyone", { model: { providerId: providerA.providerId, modelId: providerA.models[0] } }), "everyone model")
await ok(apiA("PUT", `/v1/org/default-model/teams/${platformA}`, { model: { providerId: providerA.providerId, modelId: providerA.models[1] } }), "team model")
await ok(apiA("PUT", "/v1/org/prompts/everyone", { content: "Be concise. Confidential house rules." }), "everyone prompt")
await ok(apiA("PUT", `/v1/org/prompts/teams/${platformA}`, { content: "Platform: prefer pnpm." }), "team prompt")

const sourceCtx = await contextFor(source.orgId, source.owner)

// Target organization: same team name and an equivalent provider, different ids.
const target = await den.createOrg(owner, "Extras Target")
const apiB = den.as(owner, target.orgId)
const platformB = await den.createTeam(owner, target.orgId, "Platform", [])
const providerB = await byokProvider(apiB, "Acme LLM")
const targetCtx = await contextFor(target.orgId, target.owner)
const idsAtoB = new Map<string, string>([[platformA, platformB], [providerA.providerId, providerB.providerId]])

// ---------------------------------------------------------------------------

test("export: allowlisted shapes that pass the strict schemas, refs for teams and providers", async () => {
  for (const area of AREAS) {
    const items = await area.exportItems(sourceCtx)
    const json = JSON.stringify(items)
    for (const forbidden of ["updatedAt", "createdAt", "updatedByOrgMemberId", "enc:v1:", "sk-extras-fixture", "scopeKey"]) {
      assert.ok(!json.includes(forbidden), `${area.key} export contains ${forbidden}`)
    }
    for (const item of items) {
      const parsed = area.specSchema.safeParse(item.spec)
      assert.ok(parsed.success, `${area.key} ${item.name}: ${parsed.success ? "" : parsed.error.message}`)
    }
  }

  const permissions = await membersAgentPermissionsArea.exportItems(sourceCtx)
  assert.deepEqual(permissions.map((item) => [item.key, item.name, item.spec]), [
    ["everyone", "Everyone", { team: null, settings: {
      commands: { decision: "ask", allow: ["npm test *"], block: ["rm -rf *"] },
      fileEdits: { decision: "allow" },
      webSearch: { decision: "deny" },
    } }],
    [null, "Platform", { team: { $ref: `members.teams/${platformA}`, name: "Platform" }, settings: { websites: { decision: "deny", allow: ["docs.example.com"] } } }],
  ])
  assert.match(permissions[0]?.id ?? "", /^agp_/)

  const models = await membersDefaultModelsArea.exportItems(sourceCtx)
  assert.deepEqual(models.map((item) => [item.key, item.name, item.spec]), [
    ["everyone", "Everyone", { team: null, provider: { $ref: `ai-gateway.byok/${providerA.providerId}`, name: "Acme LLM" }, modelId: providerA.models[0] }],
    [null, "Platform", { team: { $ref: `members.teams/${platformA}`, name: "Platform" }, provider: { $ref: `ai-gateway.byok/${providerA.providerId}`, name: "Acme LLM" }, modelId: providerA.models[1] }],
  ])

  const prompts = await membersPromptsArea.exportItems(sourceCtx)
  assert.equal(membersPromptsArea.containsConfidentialContent, true)
  assert.deepEqual(prompts.map((item) => [item.name, item.spec]), [
    ["Everyone", { content: "Be concise. Confidential house rules.", assignment: { everyone: true, teams: [], members: [] } }],
    ["Platform", { content: "Platform: prefer pnpm.", assignment: { everyone: false, teams: [{ $ref: `members.teams/${platformA}`, name: "Platform" }], members: [] } }],
  ])
  assert.deepEqual(prompts.map((item) => membersPromptsArea.naturalKeys[0]?.get(item)), ["everyone", "team:platform"])
  assert.deepEqual(permissions.map((item) => membersAgentPermissionsArea.naturalKeys[0]?.get(item)), ["everyone", "team:platform"])
})

test("readItems returns exactly the exported items asked for", async () => {
  for (const area of AREAS) {
    assert.ok(area.readItems, `${area.key} implements readItems`)
    const all = await area.exportItems(sourceCtx)
    const wanted = all.slice(1).map((item) => item.id)
    assert.deepEqual(await area.readItems(sourceCtx, [...wanted, "not-an-id", createDenTypeId("team")]), all.slice(1))
    assert.deepEqual(await area.readItems(sourceCtx, []), [])
  }
})

test("agent permissions: an update writes only the permission that changed", async () => {
  const [everyone] = await membersAgentPermissionsArea.exportItems(sourceCtx)
  assert.ok(everyone)
  const rowsBefore = await db.select().from(AgentPermissionSettingTable).where(eq(AgentPermissionSettingTable.policyId, normalizeDenTypeId("agentPermissionPolicy", everyone.id)))
  const settings = isRecord(everyone.spec.settings) ? everyone.spec.settings : {}
  const changes: ConfigFieldChange[] = [{ path: "settings.webSearch.decision", from: "deny", to: "allow" }]
  const result = await membersAgentPermissionsArea.apply(sourceCtx, {
    kind: "update",
    targetId: everyone.id,
    previous: everyone,
    // Also differs in fileEdits, which the plan does not name: it must stay as stored.
    item: { ...resolvedItem(everyone, new Map()), spec: { team: null, settings: { ...settings, webSearch: { decision: "allow" }, fileEdits: { decision: "deny" } } } },
    changes,
    secretPaths: [],
  })
  assert.deepEqual(result.steps?.map((step) => [step.action, step.target]), [["update", "webSearch"]])
  const rowsAfter = await db.select().from(AgentPermissionSettingTable).where(eq(AgentPermissionSettingTable.policyId, normalizeDenTypeId("agentPermissionPolicy", everyone.id)))
  const before = new Map(rowsBefore.map((row) => [row.permissionKey, row]))
  for (const row of rowsAfter) {
    const old = before.get(row.permissionKey)
    assert.ok(old)
    assert.equal(row.id, old.id, `${row.permissionKey} row kept`)
    if (row.permissionKey === "webSearch") assert.equal(row.decision, "allow")
    else assert.deepEqual([row.decision, row.updatedAt.getTime()], [old.decision, old.updatedAt.getTime()], `${row.permissionKey} untouched`)
  }
  const [reread] = await membersAgentPermissionsArea.readItems!(sourceCtx, [everyone.id])
  assert.deepEqual(isRecord(reread?.spec.settings) ? reread.spec.settings.fileEdits : null, { decision: "allow" })

  // Revert so the round trip below sees the seeded state.
  await membersAgentPermissionsArea.apply(sourceCtx, { kind: "update", targetId: everyone.id, previous: reread!, item: resolvedItem(everyone, new Map()), changes: [{ path: "settings.webSearch.decision", from: "allow", to: "deny" }], secretPaths: [] })
})

test("default models: an update with only the model changed writes it; an unknown model fails on modelId", async () => {
  const [everyone] = await membersDefaultModelsArea.exportItems(sourceCtx)
  assert.ok(everyone)
  const ids = new Map([[providerA.providerId, providerA.providerId]])
  const next = { ...resolvedItem(everyone, ids), spec: { ...resolvedItem(everyone, ids).spec, modelId: providerA.models[1] } }
  const result = await membersDefaultModelsArea.apply(sourceCtx, { kind: "update", targetId: everyone.id, previous: everyone, item: next, changes: [{ path: "modelId", from: providerA.models[0], to: providerA.models[1] }], secretPaths: [] })
  assert.equal(result.localId, everyone.id)
  assert.deepEqual(result.steps?.map((step) => step.action), ["update"])
  const [reread] = await membersDefaultModelsArea.readItems!(sourceCtx, [everyone.id])
  assert.equal(reread?.spec.modelId, providerA.models[1])

  await assert.rejects(
    membersDefaultModelsArea.apply(sourceCtx, { kind: "update", targetId: everyone.id, previous: reread!, item: { ...next, spec: { ...next.spec, modelId: "no-such-model" } }, changes: [{ path: "modelId" }], secretPaths: [] }),
    (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "unknown_model" && error.failure.field === "modelId",
  )
  await membersDefaultModelsArea.apply(sourceCtx, { kind: "update", targetId: everyone.id, previous: reread!, item: resolvedItem(everyone, ids), changes: [{ path: "modelId" }], secretPaths: [] })
})

test("prompts: an update of the text keeps the assignment rows; an assignment change adds and removes rows", async () => {
  const prompts = await membersPromptsArea.exportItems(sourceCtx)
  const team = prompts.find((item) => item.name === "Platform")
  assert.ok(team)
  const promptId = normalizeDenTypeId("orgPrompt", team.id)
  const accessBefore = await db.select().from(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.promptId, promptId))
  const ids = new Map([[platformA, platformA], [person.email.toLowerCase(), person.memberId]])
  const item = resolvedItem(team, ids)
  const result = await membersPromptsArea.apply(sourceCtx, { kind: "update", targetId: team.id, previous: team, item: { ...item, spec: { ...item.spec, content: "Platform: prefer pnpm, always." } }, changes: [{ path: "content" }], secretPaths: [] })
  assert.deepEqual(result.steps?.map((step) => [step.action, step.target]), [["update", "content"]])
  const accessAfter = await db.select().from(OrgPromptAccessTable).where(eq(OrgPromptAccessTable.promptId, promptId))
  assert.deepEqual(accessAfter.map((row) => row.id), accessBefore.map((row) => row.id))

  const [updated] = await membersPromptsArea.readItems!(sourceCtx, [team.id])
  assert.equal(updated?.spec.content, "Platform: prefer pnpm, always.")
  const withPerson = { ...item, spec: { content: "Platform: prefer pnpm, always.", assignment: { everyone: false, teams: [], members: [{ $ref: `people/${person.email.toLowerCase()}`, id: person.memberId }] } } }
  const moved = await membersPromptsArea.apply(sourceCtx, { kind: "update", targetId: team.id, previous: updated!, item: withPerson, changes: [{ path: "assignment.teams" }, { path: "assignment.members" }], secretPaths: [] })
  assert.deepEqual(moved.steps?.map((step) => [step.action, step.target]), [["remove", "assignment.teams"], ["add", "assignment.members"]])
  const [reread] = await membersPromptsArea.readItems!(sourceCtx, [team.id])
  assert.deepEqual(reread?.spec.assignment, { everyone: false, teams: [], members: [{ $ref: `people/${person.email.toLowerCase()}` }] })

  // Back to the seeded state.
  await membersPromptsArea.apply(sourceCtx, { kind: "update", targetId: team.id, previous: reread!, item, changes: [{ path: "content" }, { path: "assignment.teams" }, { path: "assignment.members" }], secretPaths: [] })
  const [restored] = await membersPromptsArea.readItems!(sourceCtx, [team.id])
  assert.deepEqual(restored?.spec, team.spec)
})

test("round trip into a second organization: refs resolve there, preferred ids are reused", async () => {
  for (const area of AREAS) {
    const exported = await area.exportItems(sourceCtx)
    const created: string[] = []
    for (const item of exported) {
      const preferredId = createDenTypeId(area === membersAgentPermissionsArea ? "agentPermissionPolicy" : area === membersDefaultModelsArea ? "orgDefaultModel" : "orgPrompt")
      const result = await area.apply(targetCtx, { kind: "create", item: resolvedItem(item, idsAtoB), preferredId })
      assert.equal(result.localId, preferredId, `${area.key} ${item.name} reuses the preferred id`)
      assert.ok((result.steps ?? []).length > 0)
      created.push(result.localId)
    }
    const imported = await area.exportItems(targetCtx)
    assert.deepEqual(imported.map((item) => item.id), created)
    assert.deepEqual(imported.map((item) => [item.name, portable(item.spec)]), exported.map((item) => [item.name, portable(item.spec)]), `${area.key} round trip`)
    for (const item of imported) {
      const json = JSON.stringify(item.spec)
      assert.ok(!json.includes(platformA) && !json.includes(providerA.providerId), `${area.key} refs point at the target`)
    }
    // Creating the same scope again is refused (scope is unique) for the per-scope areas.
    if (area !== membersPromptsArea) {
      await assert.rejects(area.apply(targetCtx, { kind: "create", item: resolvedItem(exported[0]!, idsAtoB) }), (error: unknown) => error instanceof ConfigApplyItemError && error.failure.status === 409)
    }
  }
})

test("agent permissions: a permission whose feature is off on the target is skipped with a warning", async () => {
  // The feature is turned off for the target here, not left to the registry default.
  assert.equal((await den.setFeature(target.orgId, "agentHarnessPermissions", false)).status, 200)
  const gatedCtx = await contextFor(target.orgId, target.owner)
  assert.equal(gatedCtx.features.agentHarnessPermissions, false, "fixture: harness permissions are off")
  const result = await membersAgentPermissionsArea.apply(gatedCtx, {
    kind: "update",
    targetId: (await membersAgentPermissionsArea.exportItems(gatedCtx))[0]!.id,
    previous: (await membersAgentPermissionsArea.exportItems(gatedCtx))[0]!,
    item: { name: "Everyone", key: "everyone", spec: { team: null, settings: { commands: { decision: "ask", allow: ["npm test *"], block: ["rm -rf *"] }, fileEdits: { decision: "allow" }, webSearch: { decision: "deny" }, computerUse: { decision: "deny" } } } },
    changes: [{ path: "settings.computerUse", to: { decision: "deny" } }],
    secretPaths: [],
  })
  assert.deepEqual(result.steps, [])
  assert.ok(result.warnings?.some((warning) => warning.includes("agentHarnessPermissions")), JSON.stringify(result.warnings))
})

test("delete removes the scope's configuration", async () => {
  for (const area of AREAS) {
    const items = await area.exportItems(targetCtx)
    const team = items.find((item) => item.name === "Platform")
    assert.ok(team, `${area.key} team item`)
    const result = await area.apply(targetCtx, { kind: "delete", targetId: team.id, previous: team })
    assert.equal(result.localId, team.id)
    assert.ok((result.steps ?? []).some((step) => step.action === "delete" || step.action === "remove"))
    assert.deepEqual((await area.exportItems(targetCtx)).map((item) => item.id), items.filter((item) => item.id !== team.id).map((item) => item.id))
    assert.deepEqual(area.irreversible?.({ kind: "delete", targetId: team.id, previous: team }), [])
  }
})

test("prompts: importing (dry run or upload) needs prompts.view as well as prompts.manage, so a plan never shows prompt text to a manager who can't view it", async () => {
  const exported = await ok(apiA("GET", "/v1/config-blobs/export?areas=members.prompts"), "export prompts")
  const blob = JSON.parse(JSON.stringify(exported.body))
  assert.ok(JSON.stringify(blob).includes("Confidential house rules"), "the owner's export carries the text")

  const manager = await den.newMember(owner, source.orgId, "Prompt Manager")
  const managers = await den.createTeam(owner, source.orgId, "Prompt managers", [manager.memberId])
  await ok(apiA("POST", "/v1/permissions/sets", { name: "Manage prompts only", teamIds: [managers], permissions: [{ key: "prompts.manage", status: "allow" }] }), "manage-only role")
  const managerApi = den.as(manager, source.orgId)

  for (const path of ["/v1/config-blobs/change-requests?dryRun=true", "/v1/config-blobs/change-requests"]) {
    const refused = await managerApi("POST", path, { blob, mode: "merge" })
    assert.equal(refused.status, 403, summary(refused))
    assert.equal(field(refused.body, "error"), "forbidden")
    assert.deepEqual(field(refused.body, "areas"), ["members.prompts"])
    assert.deepEqual(field(refused.body, "requiredPermissions"), ["prompts.view"])
    assert.ok(String(field(refused.body, "message")).includes("view and to manage"), summary(refused))
    assert.ok(!JSON.stringify(refused.body).includes("Confidential house rules"), "the refusal shows no prompt text")
  }

  const viewers = await den.createTeam(owner, source.orgId, "Prompt viewers", [manager.memberId])
  await ok(apiA("POST", "/v1/permissions/sets", { name: "View prompts", teamIds: [viewers], permissions: [{ key: "prompts.view", status: "allow" }] }), "view role")
  const allowed = await managerApi("POST", "/v1/config-blobs/change-requests?dryRun=true", { blob, mode: "merge" })
  assert.equal(allowed.status, 200, summary(allowed))
})
