/**
 * Config-blob adapters for Plugins: skills (config objects), plugins and
 * sources. Export shape (content included, nothing secret, personal objects
 * left out), duplicate names, readItems, minimal updates (content → one new
 * version, access → grants only), source-managed objects, and a round trip
 * into a second organization with preferred ids and resolved references.
 *
 * Resources are created through the public API; the adapters are called
 * directly with a ConfigAreaContext, as the engine does.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(async () => {
  await den.close()
})

const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { ConfigApplyItemError } = await import("../../src/config-blobs/area.js")
const { pluginsSkillsArea } = await import("../../src/config-blobs/areas/plugins-skills.js")
const { pluginsPluginsArea } = await import("../../src/config-blobs/areas/plugins-plugins.js")
const { pluginsSourcesArea } = await import("../../src/config-blobs/areas/plugins-sources.js")
const { and, eq, isNull } = await import("@openwork-ee/den-db/drizzle")
const {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectorSyncEventTable,
} = await import("@openwork-ee/den-db/schema")

type Area = typeof pluginsSkillsArea
type Item = Awaited<ReturnType<Area["exportItems"]>>[number]
type Ctx = Parameters<Area["exportItems"]>[0]

const owner = await den.signUp("Plugins Owner")
const orgA = await den.createOrg(owner, "Plugins source")
const orgB = await den.createOrg(owner, "Plugins target")
const teammate = await den.newMember(owner, orgA.orgId, "Plugins Teammate")
const apiA = den.as(owner, orgA.orgId)
const apiB = den.as(owner, orgB.orgId)
const teamA = await den.createTeam(owner, orgA.orgId, "Research", [teammate.memberId])
const teamB = await den.createTeam(owner, orgB.orgId, "Research B", [])

const skillMarkdown = (body: string, name = "dup-skill") => `---\nname: ${name}\ndescription: A skill used by the config blob tests.\n---\n\n${body}\n`

async function ctxFor(org: { orgId: string; owner: { userId: string; memberId: string } }): Promise<Ctx> {
  return {
    db,
    organizationId: org.orgId,
    actor: { userId: org.owner.userId, memberId: org.owner.memberId },
    deployment: "self_hosted",
    features: await getOrganizationFeatures(org.orgId),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** What the engine hands an adapter: refs resolved (`id` added, unknown ones dropped). */
function resolve(value: unknown, refs: (ref: string) => string | null): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (isObject(entry) && typeof entry.$ref === "string") {
        const id = refs(entry.$ref)
        return id ? [{ ...entry, id }] : []
      }
      return [resolve(entry, refs)]
    })
  }
  if (!isObject(value)) return value
  if (typeof value.$ref === "string") {
    const id = refs(value.$ref)
    return id ? { ...value, id } : null
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, refs)]))
}

function resolvedSpec(value: unknown, refs: (ref: string) => string | null): Record<string, unknown> {
  const spec = resolve(value, refs)
  assert.ok(isObject(spec))
  return spec
}

/** Same-org refs: every `<area>/<id>` resolves to itself, people by email. */
function sameOrgRefs(ref: string): string | null {
  if (ref === `people/${owner.email.toLowerCase()}`) return orgA.owner.memberId
  if (ref === `people/${teammate.email.toLowerCase()}`) return teammate.memberId
  if (ref.startsWith("people/")) return null
  return ref.slice(ref.indexOf("/") + 1)
}

async function versionCount(configObjectId: string): Promise<number> {
  const rows = await db.select({ id: ConfigObjectVersionTable.id }).from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.configObjectId, normalizeConfigObjectId(configObjectId)))
  return rows.length
}

async function activeGrantIds(configObjectId: string): Promise<string[]> {
  const rows = await db.select({ id: ConfigObjectAccessGrantTable.id }).from(ConfigObjectAccessGrantTable)
    .where(and(eq(ConfigObjectAccessGrantTable.configObjectId, normalizeConfigObjectId(configObjectId)), isNull(ConfigObjectAccessGrantTable.removedAt)))
  return rows.map((row) => row.id).sort()
}

function normalizeConfigObjectId(id: string) {
  return normalizeDenTypeId("configObject", id)
}

function contentOf(item: Item): Record<string, unknown> {
  const content = item.spec.content
  assert.ok(isObject(content))
  return content
}

function refsOf(value: unknown): string[] {
  assert.ok(Array.isArray(value))
  return value.map((entry) => {
    assert.ok(isObject(entry) && typeof entry.$ref === "string")
    return entry.$ref
  })
}

function only(items: Item[], predicate: (item: Item) => boolean, label: string): Item {
  const matches = items.filter(predicate)
  assert.equal(matches.length, 1, `exactly one ${label}`)
  const item = matches[0]
  assert.ok(item)
  return item
}

let skillOne = ""
let skillTwo = ""
let personalSkill = ""
let managedSkill = ""
let pluginId = ""
let personalPluginId = ""
let marketplaceId = ""
let instanceId = ""

before(async () => {
  const marketplace = await apiA("POST", "/v1/marketplaces", { name: "Research tools" })
  assert.ok(marketplace.status < 300, summary(marketplace))
  marketplaceId = text(field(marketplace.body, "item", "id"), "marketplace id")

  const plugin = await apiA("POST", "/v1/plugins", { name: "Research" , description: "Research helpers" })
  assert.equal(plugin.status, 201, summary(plugin))
  pluginId = text(field(plugin.body, "item", "id"), "plugin id")
  const pluginGrant = await apiA("POST", `/v1/plugins/${pluginId}/access`, { teamId: teamA, role: "viewer" })
  assert.equal(pluginGrant.status, 201, summary(pluginGrant))
  const listed = await apiA("POST", `/v1/marketplaces/${marketplaceId}/plugins`, { pluginId })
  assert.ok(listed.status < 300, summary(listed))

  const one = await apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("Summarize the sources first.") } })
  assert.equal(one.status, 201, summary(one))
  skillOne = text(field(one.body, "item", "id"), "skill one")
  const oneGrant = await apiA("POST", `/v1/config-objects/${skillOne}/access`, { teamId: teamA, role: "viewer" })
  assert.equal(oneGrant.status, 201, summary(oneGrant))

  // Same title, different content.
  const two = await apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", input: { rawSourceText: skillMarkdown("Write a haiku about the result.") } })
  assert.equal(two.status, 201, summary(two))
  skillTwo = text(field(two.body, "item", "id"), "skill two")
  const twoGrant = await apiA("POST", `/v1/config-objects/${skillTwo}/access`, { orgWide: true, role: "viewer" })
  assert.equal(twoGrant.status, 201, summary(twoGrant))

  // Only its creator can reach it: personal.
  const personal = await apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", input: { rawSourceText: skillMarkdown("My private notes.", "private-skill") } })
  assert.equal(personal.status, 201, summary(personal))
  personalSkill = text(field(personal.body, "item", "id"), "personal skill")
  const personalPlugin = await apiA("POST", "/v1/plugins", { name: "My drafts" })
  assert.equal(personalPlugin.status, 201, summary(personalPlugin))
  personalPluginId = text(field(personalPlugin.body, "item", "id"), "personal plugin")

  // A source with one target and one mapping into the plugin.
  const account = await apiA("POST", "/v1/connector-accounts", { connectorType: "github", remoteId: "424242", displayName: "acme", externalAccountRef: "acme" })
  assert.ok(account.status < 300, summary(account))
  const accountId = text(field(account.body, "item", "id"), "account id")
  const instance = await apiA("POST", "/v1/connector-instances", { connectorAccountId: accountId, connectorType: "github", name: "Acme docs", remoteId: "acme/docs", config: { autoImportNewPlugins: false, installationId: 424242 } })
  assert.equal(instance.status, 201, summary(instance))
  instanceId = text(field(instance.body, "item", "id"), "instance id")
  const target = await apiA("POST", `/v1/connector-instances/${instanceId}/targets`, {
    connectorType: "github",
    remoteId: "acme/docs",
    targetKind: "repository_branch",
    externalTargetRef: "main",
    config: { branch: "main", ref: "refs/heads/main", repositoryFullName: "acme/docs", repositoryId: 99, githubDiscoveryCache: { warnings: ["cached"] } },
  })
  assert.ok(target.status < 300, summary(target))
  const targetId = text(field(target.body, "item", "id"), "target id")
  const mapping = await apiA("POST", `/v1/connector-targets/${targetId}/mappings`, { mappingKind: "path", selector: "skills/**", objectType: "skill", pluginId, autoAddToPlugin: true, config: { discoverySourceKind: "skill" } })
  assert.ok(mapping.status < 300, summary(mapping))

  // A skill synced from that source (the sync worker writes these; set it up directly).
  const managed = await apiA("POST", "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("Synced from GitHub.", "synced-skill") } })
  assert.equal(managed.status, 201, summary(managed))
  managedSkill = text(field(managed.body, "item", "id"), "managed skill")
  await db.update(ConfigObjectTable).set({ sourceMode: "connector", connectorInstanceId: normalizeDenTypeId("connectorInstance", instanceId), currentRelativePath: "skills/synced/SKILL.md" })
    .where(eq(ConfigObjectTable.id, normalizeConfigObjectId(managedSkill)))
})

test("skills export: content included, nothing secret, duplicates kept apart, personal objects left out", async () => {
  const ctx = await ctxFor(orgA)
  const items = await pluginsSkillsArea.exportItems(ctx)
  for (const item of items) {
    const parsed = pluginsSkillsArea.specSchema.safeParse(item.spec)
    assert.ok(parsed.success, `${item.name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`)
  }
  const json = JSON.stringify(items)
  assert.ok(!json.includes("$secret"), "no secret placeholders")
  assert.ok(!json.includes("enc:v1:"), "no ciphertext")
  assert.ok(!items.some((item) => item.id === personalSkill), "personal skill is not exported")

  const dups = items.filter((item) => item.name === "dup-skill")
  assert.equal(dups.length, 2, "both same-named skills are exported")
  const one = only(items, (item) => item.id === skillOne, "skill one")
  const two = only(items, (item) => item.id === skillTwo, "skill two")
  assert.equal(one.spec.type, "skill")
  assert.match(String(field(one.spec, "content", "rawSourceText")), /Summarize the sources first/)
  assert.deepEqual(field(one.spec, "access", "teams", "viewer"), [{ $ref: `members.teams/${teamA}`, name: "Research" }])
  assert.deepEqual(field(one.spec, "access", "members", "manager"), [{ $ref: `people/${owner.email.toLowerCase()}` }])
  assert.equal(field(two.spec, "access", "orgWide"), "viewer")
  assert.equal(one.spec.managedBy, "manual")

  // Similarity: identical content beats a same-named skill with other content.
  const similarity = pluginsSkillsArea.similarity
  assert.ok(similarity)
  const self = similarity(one, one)
  const other = similarity(one, two)
  assert.ok(self.score > 0.95, `self ${self.score}`)
  assert.ok(other.score < 0.7, `other ${other.score}`)
  assert.ok(other.reasons.includes("same title"))
  assert.equal(similarity(one, { ...one, spec: { ...one.spec, type: "command" } }).score, 0)

  const managed = only(items, (item) => item.id === managedSkill, "managed skill")
  assert.equal(managed.spec.managedBy, "source")
  assert.equal(managed.spec.source, "Acme docs")
  assert.equal(pluginsSkillsArea.naturalKeys[0]?.get(managed), "acme docs\nskills/synced/SKILL.md")
  assert.ok(pluginsSkillsArea.protectedFromDelete?.(managed, ctx))
})

test("skills readItems returns only the asked ids", async () => {
  const ctx = await ctxFor(orgA)
  assert.ok(pluginsSkillsArea.readItems)
  const items = await pluginsSkillsArea.readItems(ctx, [skillOne, createDenTypeId("configObject")])
  assert.deepEqual(items.map((item) => item.id), [skillOne])
  const all = await pluginsSkillsArea.exportItems(ctx)
  assert.deepEqual(items[0], all.find((item) => item.id === skillOne))
})

test("a content change adds exactly one version and leaves grants alone; an access change only touches grants", async () => {
  const ctx = await ctxFor(orgA)
  const [previous] = await pluginsSkillsArea.readItems!(ctx, [skillOne])
  assert.ok(previous)
  const versionsBefore = await versionCount(skillOne)
  const grantsBefore = await activeGrantIds(skillOne)

  const changedContent = { ...previous.spec, content: { ...contentOf(previous), rawSourceText: skillMarkdown("Summarize the sources, then cite them.") } }
  const result = await pluginsSkillsArea.apply(ctx, {
    kind: "update",
    targetId: skillOne,
    previous,
    item: { sourceId: skillOne, name: previous.name, spec: resolvedSpec(changedContent, sameOrgRefs) },
    changes: [{ path: "content.rawSourceText", from: "old", to: "new" }],
    secretPaths: [],
  })
  assert.equal(result.localId, skillOne)
  assert.deepEqual(result.steps, [{ action: "create", target: "content", detail: "new version" }])
  assert.equal(await versionCount(skillOne), versionsBefore + 1)
  assert.deepEqual(await activeGrantIds(skillOne), grantsBefore, "grants untouched")
  assert.ok((pluginsSkillsArea.irreversible?.({
    kind: "update", targetId: skillOne, previous, item: { name: previous.name, spec: changedContent }, changes: [{ path: "content.rawSourceText" }], secretPaths: [],
  }) ?? []).length > 0)

  const [afterContent] = await pluginsSkillsArea.readItems!(ctx, [skillOne])
  assert.ok(afterContent)
  assert.match(String(field(afterContent.spec, "content", "rawSourceText")), /cite them/)
  const access = { orgWide: null, teams: { viewer: [], editor: [{ $ref: `members.teams/${teamA}`, name: "Research" }], manager: [] }, members: field(afterContent.spec, "access", "members") }
  const accessResult = await pluginsSkillsArea.apply(ctx, {
    kind: "update",
    targetId: skillOne,
    previous: afterContent,
    item: { sourceId: skillOne, name: afterContent.name, spec: resolvedSpec({ ...afterContent.spec, access }, sameOrgRefs) },
    changes: [{ path: "access.teams.viewer", removed: ["Research"] }, { path: "access.teams.editor", added: ["Research"] }],
    secretPaths: [],
  })
  assert.deepEqual(accessResult.steps, [{ action: "set", target: "access.teams", detail: "Research (editor)" }])
  assert.equal(await versionCount(skillOne), versionsBefore + 1, "no new version for an access change")
  const [afterAccess] = await pluginsSkillsArea.readItems!(ctx, [skillOne])
  assert.deepEqual(field(afterAccess?.spec, "access", "teams", "editor"), [{ $ref: `members.teams/${teamA}`, name: "Research" }])
  assert.deepEqual(field(afterAccess?.spec, "access", "teams", "viewer"), [])
})

test("source-managed skills refuse content writes and creates", async () => {
  const ctx = await ctxFor(orgA)
  const [managed] = await pluginsSkillsArea.readItems!(ctx, [managedSkill])
  assert.ok(managed)
  await assert.rejects(pluginsSkillsArea.apply(ctx, {
    kind: "update",
    targetId: managedSkill,
    previous: managed,
    item: { name: managed.name, spec: resolvedSpec({ ...managed.spec, content: { ...contentOf(managed), rawSourceText: skillMarkdown("Edited", "synced-skill") } }, sameOrgRefs) },
    changes: [{ path: "content.rawSourceText" }],
    secretPaths: [],
  }), (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "source_managed" && error.failure.field === "content")
  await assert.rejects(pluginsSkillsArea.apply(await ctxFor(orgB), {
    kind: "create",
    item: { name: managed.name, spec: resolvedSpec(managed.spec, () => null) },
  }), (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "source_managed")
})

test("plugins export: components, collections, access; personal plugins left out", async () => {
  const ctx = await ctxFor(orgA)
  const items = await pluginsPluginsArea.exportItems(ctx)
  for (const item of items) {
    const parsed = pluginsPluginsArea.specSchema.safeParse(item.spec)
    assert.ok(parsed.success, `${item.name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`)
  }
  assert.ok(!items.some((item) => item.id === personalPluginId), "personal plugin is not exported")
  const research = only(items, (item) => item.id === pluginId, "plugin")
  assert.deepEqual(
    refsOf(research.spec.components).sort(),
    [`plugins.skills/${managedSkill}`, `plugins.skills/${skillOne}`].sort(),
  )
  assert.deepEqual(research.spec.collections, [{ $ref: `settings.advanced.collections/${marketplaceId}`, name: "Research tools" }])
  assert.deepEqual(field(research.spec, "access", "teams", "viewer"), [{ $ref: `members.teams/${teamA}`, name: "Research" }])
  assert.equal(research.spec.managedBy, "source")
  assert.ok(pluginsPluginsArea.protectedFromDelete?.(research, ctx))
  // Every component reference points at an exported skill.
  const skills = new Set((await pluginsSkillsArea.exportItems(ctx)).map((item) => `plugins.skills/${item.id}`))
  for (const ref of refsOf(research.spec.components)) assert.ok(skills.has(ref), ref)
})

test("sources export: config only, runtime cache and installation left out, mapping refs a plugin", async () => {
  const ctx = await ctxFor(orgA)
  const items = await pluginsSourcesArea.exportItems(ctx)
  const source = only(items, (item) => item.id === instanceId, "source")
  const parsed = pluginsSourcesArea.specSchema.safeParse(source.spec)
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues))
  assert.ok(!JSON.stringify(source).includes("githubDiscoveryCache"))
  assert.equal(source.spec.repository, "acme/docs")
  assert.equal(source.spec.autoImportNewPlugins, false)
  assert.deepEqual(source.spec.account, { remoteId: "424242", displayName: "acme", login: "acme" })
  assert.deepEqual(source.spec.targets, [{
    remoteId: "acme/docs",
    targetKind: "repository_branch",
    branch: "main",
    config: { branch: "main", ref: "refs/heads/main", repositoryFullName: "acme/docs", repositoryId: 99 },
    mappings: [{
      key: "skill:skills/**",
      mappingKind: "path",
      selector: "skills/**",
      objectType: "skill",
      plugin: { $ref: `plugins.plugins/${pluginId}`, name: "Research" },
      autoAddToPlugin: true,
      config: { discoverySourceKind: "skill" },
    }],
  }])
})

test("round trip into a second organization: preferred ids, refs resolve, sources need the GitHub account", async () => {
  const ctxA = await ctxFor(orgA)
  const ctxB = await ctxFor(orgB)
  const marketplaceB = await apiB("POST", "/v1/marketplaces", { name: "Research tools" })
  assert.ok(marketplaceB.status < 300, summary(marketplaceB))
  const marketplaceBId = text(field(marketplaceB.body, "item", "id"), "marketplace B")

  const skills = (await pluginsSkillsArea.exportItems(ctxA)).filter((item) => item.spec.managedBy !== "source")
  const localIds = new Map<string, string>()
  const otherOrgRefs = (ref: string): string | null => {
    if (ref === `members.teams/${teamA}`) return teamB
    if (ref === `people/${owner.email.toLowerCase()}`) return orgB.owner.memberId
    if (ref === `settings.advanced.collections/${marketplaceId}`) return marketplaceBId
    return localIds.get(ref) ?? null
  }
  for (const skill of skills) {
    const preferredId = createDenTypeId("configObject")
    const result = await pluginsSkillsArea.apply(ctxB, { kind: "create", preferredId, item: { sourceId: skill.id, name: skill.name, spec: resolvedSpec(skill.spec, otherOrgRefs) } })
    assert.equal(result.localId, preferredId, "the preferred id is reused")
    localIds.set(`plugins.skills/${skill.id}`, result.localId)
  }
  const exportedB = await pluginsSkillsArea.exportItems(ctxB)
  assert.equal(exportedB.filter((item) => item.name === "dup-skill").length, 2)
  const oneB = exportedB.find((item) => item.id === localIds.get(`plugins.skills/${skillOne}`))
  assert.ok(oneB)
  assert.match(String(field(oneB.spec, "content", "rawSourceText")), /cite them/)
  assert.deepEqual(field(oneB.spec, "access", "teams", "editor"), [{ $ref: `members.teams/${teamB}`, name: "Research B" }])
  assert.equal(await versionCount(oneB.id), 1)

  const plugin = (await pluginsPluginsArea.exportItems(ctxA)).find((item) => item.id === pluginId)
  assert.ok(plugin)
  const preferredPluginId = createDenTypeId("plugin")
  const created = await pluginsPluginsArea.apply(ctxB, { kind: "create", preferredId: preferredPluginId, item: { sourceId: plugin.id, name: plugin.name, spec: resolvedSpec(plugin.spec, otherOrgRefs) } })
  assert.equal(created.localId, preferredPluginId)
  assert.ok(created.steps?.some((step) => step.action === "add" && step.target === "collections"))
  localIds.set(`plugins.plugins/${pluginId}`, created.localId)
  const pluginB = (await pluginsPluginsArea.readItems!(ctxB, [created.localId]))[0]
  assert.ok(pluginB)
  // The synced skill is dropped (unresolved); the hand-made one resolves to its new id.
  assert.deepEqual(pluginB.spec.components, [{ $ref: `plugins.skills/${localIds.get(`plugins.skills/${skillOne}`)}`, name: "dup-skill" }])
  assert.deepEqual(pluginB.spec.collections, [{ $ref: `settings.advanced.collections/${marketplaceBId}`, name: "Research tools" }])
  assert.deepEqual(field(pluginB.spec, "access", "teams", "viewer"), [{ $ref: `members.teams/${teamB}`, name: "Research B" }])

  // Sources: without the GitHub installation here the source can't be created.
  const source = (await pluginsSourcesArea.exportItems(ctxA)).find((item) => item.id === instanceId)
  assert.ok(source)
  const sourceSpec = resolvedSpec(source.spec, otherOrgRefs)
  await assert.rejects(
    pluginsSourcesArea.apply(ctxB, { kind: "create", item: { name: source.name, spec: sourceSpec } }),
    (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "needs_setup" && error.failure.field === "account",
  )
  const accountB = await apiB("POST", "/v1/connector-accounts", { connectorType: "github", remoteId: "424242", displayName: "acme" })
  assert.ok(accountB.status < 300, summary(accountB))
  const preferredInstanceId = createDenTypeId("connectorInstance")
  const createdSource = await pluginsSourcesArea.apply(ctxB, { kind: "create", preferredId: preferredInstanceId, item: { name: source.name, spec: sourceSpec } })
  assert.equal(createdSource.localId, preferredInstanceId)
  assert.ok(createdSource.steps?.some((step) => step.detail === "sync queued"), "a sync is queued")
  assert.ok(pluginsSourcesArea.irreversible?.({ kind: "create", item: { name: source.name, spec: sourceSpec } }).length)
  const queued = await db.select({ id: ConnectorSyncEventTable.id }).from(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.connectorInstanceId, preferredInstanceId))
  assert.equal(queued.length, 1)
  const sourceB = (await pluginsSourcesArea.readItems!(ctxB, [preferredInstanceId]))[0]
  assert.ok(sourceB)
  const [targetB] = list(sourceB.spec.targets)
  const [mappingB] = list(targetB?.mappings)
  assert.deepEqual(mappingB?.plugin, { $ref: `plugins.plugins/${created.localId}`, name: "Research" })
  assert.equal(sourceB.spec.autoImportNewPlugins, false)
})

test("plugins update writes only the changed collection membership", async () => {
  const ctx = await ctxFor(orgA)
  const [previous] = await pluginsPluginsArea.readItems!(ctx, [pluginId])
  assert.ok(previous)
  const result = await pluginsPluginsArea.apply(ctx, {
    kind: "update",
    targetId: pluginId,
    previous,
    item: { sourceId: pluginId, name: previous.name, spec: resolvedSpec({ ...previous.spec, collections: [] }, sameOrgRefs) },
    changes: [{ path: "collections", removed: ["Research tools"] }],
    secretPaths: [],
  })
  assert.deepEqual(result.steps, [{ action: "remove", target: "collections", detail: "Research tools" }])
  const [after] = await pluginsPluginsArea.readItems!(ctx, [pluginId])
  assert.deepEqual(after?.spec.collections, [])
  assert.deepEqual(after?.spec.components, previous.spec.components)
})
