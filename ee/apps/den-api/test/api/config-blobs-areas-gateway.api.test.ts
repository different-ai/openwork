/**
 * Config-blob area `ai-gateway.providers`: export allowlist and secret
 * placeholders, apply through the Gateway writers (keep / value / unset
 * secrets, source id reuse) and the export → import → export round trip.
 * The engine is not involved: refs and placeholders are resolved here the way
 * the engine hands them to `apply`.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ResolvedConfigSecret } from "@openwork/types/den/config-blobs"
import type { ConfigAreaContext, ConfigItem } from "../../src/config-blobs/area.js"
import { ConfigApplyItemError } from "../../src/config-blobs/area.js"
import { updateOp } from "./config-blobs-area-ops.js"
import { gatewayFixtureEnv, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, isRecord, summary, text, type Member } from "./harness.js"

const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => { restoreFetch(); await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { aiGatewayProvidersArea: area } = await import("../../src/config-blobs/areas/ai-gateway-providers.js")

const SECRET = "sk-config-blob-fixture-secret-0001"
const SECRET_2 = "sk-config-blob-fixture-secret-0002"

async function context(orgId: string, owner: Member): Promise<ConfigAreaContext> {
  return { db, organizationId: orgId, actor: { userId: owner.userId, memberId: owner.memberId }, deployment: "cloud", features: await getOrganizationFeatures(orgId) }
}

type Resolve = { teams: Map<string, string>; people: Map<string, string>; secret: (path: string, set: boolean) => ResolvedConfigSecret }

/** What the engine hands apply: refs with their local id, placeholders as decisions. */
function resolveSpec(value: unknown, resolve: Resolve): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveSpec(entry, resolve))
  if (!isRecord(value)) return value
  if (typeof value.$secret === "string") return resolve.secret(value.$secret, value.set === true)
  if (typeof value.$ref === "string") {
    const [area, target] = [value.$ref.slice(0, value.$ref.indexOf("/")), value.$ref.slice(value.$ref.indexOf("/") + 1)]
    const id = area === "people" ? resolve.people.get(target) : resolve.teams.get(target)
    assert.ok(id, `unresolved ${value.$ref}`)
    return { ...value, id }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveSpec(entry, resolve)]))
}
function asSpec(value: unknown): { [key: string]: unknown } {
  assert.ok(isRecord(value))
  return value
}

async function setup(label: string) {
  const owner = (await den.createOrg(await den.signUp(`${label} Owner`), `${label} org`))
  const member = await den.newMember(owner.owner, owner.orgId, `${label} Member`)
  const teamId = await den.createTeam(owner.owner, owner.orgId, "Platform", [member.memberId])
  return { orgId: owner.orgId, owner: owner.owner, member, teamId }
}

async function createSourceProvider(org: Awaited<ReturnType<typeof setup>>) {
  const call = den.as(org.owner, org.orgId)
  const created = await call("POST", "/v1/inference-providers", { name: "Fixture OpenAI (prod)", providerId: "openai", modelIds: ["gpt-6-luna", "gpt-fixture-other"] })
  assert.equal(created.status, 201, summary(created))
  const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  const group = await call("POST", `/v1/inference-providers/${providerId}/model-groups`, { name: "Luna only", description: "Just Luna", modelIds: ["gpt-6-luna"] })
  assert.equal(group.status, 201, summary(group))
  const groupId = text(field(group.body, "modelGroup", "id"), "group id")
  const set = await call("POST", `/v1/inference-providers/${providerId}/credential-sets`, { name: "Shared key", credentialMode: "org", credential: { kind: "api_key", secret: SECRET } })
  assert.equal(set.status, 201, summary(set))
  const setId = text(field(set.body, "credentialSet", "id"), "set id")
  for (const audience of [{ type: "team", teamId: org.teamId }, { type: "member", memberId: org.member.memberId }]) {
    const grant = await call("POST", `/v1/inference-providers/${providerId}/access-grants`, { modelGroupId: groupId, credentialSetId: setId, audience })
    assert.equal(grant.status, 201, summary(grant))
  }
  return { providerId, groupId, setId }
}

async function exportOne(org: { orgId: string; owner: Member }, providerId?: string): Promise<ConfigItem> {
  const items = await area.exportItems(await context(org.orgId, org.owner))
  const item = providerId ? items.find((entry) => entry.id === providerId) : items[0]
  assert.ok(item, "provider exported")
  return item
}

async function orgCredential(setId: string) {
  const [row] = await db.select().from(GatewayProviderCredentialTable).where(and(eq(GatewayProviderCredentialTable.credential_set_id, normalizeDenTypeId("gatewayCredentialSet", setId)), eq(GatewayProviderCredentialTable.subject, "org")))
  return row ?? null
}

async function grantRows(providerId: string) {
  return (await db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, normalizeDenTypeId("inferenceProvider", providerId)))).sort((a, b) => a.id.localeCompare(b.id))
}

/** Specs compared across orgs: team refs point at each org's own team. */
function withoutTeamIds(spec: unknown): unknown {
  return JSON.parse(JSON.stringify(spec, (key, value: unknown) => key === "$ref" && typeof value === "string" && value.startsWith("members.teams/") ? "members.teams/*" : value))
}

const source = await setup("Gateway Blob Source")
const sourceIds = await createSourceProvider(source)
const sourceExport = await exportOne(source, sourceIds.providerId)

test("export carries the configuration, references and placeholders, never a secret", () => {
  const json = JSON.stringify(sourceExport)
  assert.ok(!json.includes(SECRET), "the key never leaves Den")
  assert.ok(!json.includes("enc:v1:"), "no ciphertext either")
  assert.ok(!/"provider_config"|"model_config"/.test(json), "no raw rows")
  assert.equal(sourceExport.name, "Fixture OpenAI (prod)")
  const spec = asSpec(sourceExport.spec)
  assert.equal(area.specSchema.safeParse(spec).success, true, "the export satisfies the area's strict schema")
  assert.equal(spec.providerId, "openai")
  assert.deepEqual(spec.modelIds, ["gpt-6-luna", "gpt-fixture-other"])
  const sets = Array.isArray(spec.credentialSets) ? spec.credentialSets.filter(isRecord) : []
  const shared = sets.find((set) => set.id === sourceIds.setId)
  assert.ok(shared)
  assert.deepEqual(shared.credential, { $secret: `ai-gateway.providers/${sourceIds.providerId}/credentialSets[${sourceIds.setId}].credential`, set: true })
  assert.deepEqual(shared.oauthClientSecret, { $secret: `ai-gateway.providers/${sourceIds.providerId}/credentialSets[${sourceIds.setId}].oauthClientSecret`, set: false })
  assert.equal(shared.credentialKind, "api_key")
  const groups = Array.isArray(spec.modelGroups) ? spec.modelGroups.filter(isRecord) : []
  assert.deepEqual(groups.find((group) => group.id === sourceIds.groupId)?.models, ["gpt-6-luna"])
  const access = Array.isArray(spec.access) ? spec.access.filter(isRecord) : []
  assert.equal(access.length, 2)
  assert.deepEqual(access.find((grant) => grant.audience === "team")?.team, { $ref: `members.teams/${source.teamId}`, name: "Platform" })
  assert.equal(field(access.find((grant) => grant.audience === "member"), "member", "$ref"), `people/${source.member.email.toLowerCase()}`)
})

test("update: keep preserves the stored key, value replaces it", async () => {
  const ctx = await context(source.orgId, source.owner)
  const resolve = (secret: (path: string, set: boolean) => ResolvedConfigSecret): Resolve => ({ teams: new Map([[source.teamId, source.teamId]]), people: new Map([[source.member.email.toLowerCase(), source.member.memberId]]), secret })
  const before = await orgCredential(sourceIds.setId)
  assert.equal(before?.secret, SECRET)
  const edited = asSpec(resolveSpec(sourceExport.spec, resolve((path) => ({ $secret: path, decision: path.endsWith(".credential") ? "keep" : "unset" }))))
  edited.modelIds = ["gpt-6-luna"]
  const grantsBefore = await grantRows(sourceIds.providerId)
  const setsBefore = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, normalizeDenTypeId("inferenceProvider", sourceIds.providerId)))
  const keptOp = updateOp(area, sourceExport, { sourceId: sourceIds.providerId, name: "Fixture OpenAI (renamed)", spec: edited })
  assert.deepEqual(keptOp.changes.map((change) => change.path), ["name", "modelIds"])
  assert.deepEqual(area.irreversible?.(keptOp), [], "a rename and a smaller model policy can be undone")
  const kept = await area.apply(ctx, keptOp)
  assert.equal(kept.localId, sourceIds.providerId)
  assert.deepEqual(kept.steps, [{ action: "update", target: "provider", detail: "name, modelIds" }], "only the provider fields are written")
  assert.deepEqual(await grantRows(sourceIds.providerId), grantsBefore, "grants are not rewritten")
  assert.deepEqual(await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, normalizeDenTypeId("inferenceProvider", sourceIds.providerId))), setsBefore, "credential sets are not rewritten")
  assert.equal((await orgCredential(sourceIds.setId))?.secret, SECRET, "keep leaves the key alone")
  const afterKeep = await exportOne(source, sourceIds.providerId)
  assert.equal(afterKeep.name, "Fixture OpenAI (renamed)")
  assert.deepEqual(asSpec(afterKeep.spec).modelIds, ["gpt-6-luna"])
  assert.equal(JSON.stringify(afterKeep.spec.access), JSON.stringify(sourceExport.spec.access), "grants untouched, same ids")

  const replaced = asSpec(resolveSpec(sourceExport.spec, resolve((path) => path.endsWith(".credential") ? { $secret: path, decision: "value", value: SECRET_2 } : { $secret: path, decision: "unset" })))
  const replaceOp = updateOp(area, afterKeep, { sourceId: sourceIds.providerId, name: sourceExport.name, spec: replaced })
  assert.deepEqual(replaceOp.secretPaths, [`credentialSets[id=${sourceIds.setId}].credential`])
  assert.deepEqual(area.irreversible?.(replaceOp), [`The stored key of credential set "Shared key" is replaced; the previous value can't be restored.`])
  const replacedResult = await area.apply(ctx, replaceOp)
  assert.deepEqual(replacedResult.steps, [
    { action: "update", target: "provider", detail: "name, modelIds, models" },
    // Narrowing the policy took the model out of the default group too; it goes back in.
    { action: "update", target: "modelGroups[All Allowed Models]", detail: "modelIds" },
    { action: "update", target: "credentialSets[Shared key]", detail: "credential" },
  ])
  assert.equal((await orgCredential(sourceIds.setId))?.secret, SECRET_2, "value writes the new key")
  const restored = await exportOne(source, sourceIds.providerId)
  assert.deepEqual(restored.spec, sourceExport.spec, "back to the exported spec")
  assert.ok(!JSON.stringify(restored).includes(SECRET_2))
})

test("readItems reads just those providers, the same as the export", async () => {
  const ctx = await context(source.orgId, source.owner)
  const exported = await area.exportItems(ctx)
  assert.deepEqual(await area.readItems?.(ctx, [sourceIds.providerId, "ipr_missing"]), exported.filter((item) => item.id === sourceIds.providerId))
  assert.deepEqual(await area.readItems?.(ctx, []), [])
})

test("a group edit writes that group only; a failing grant rolls the item back and names the step", async () => {
  const ctx = await context(source.orgId, source.owner)
  const current = await exportOne(source, sourceIds.providerId)
  const resolve: Resolve = { teams: new Map([[source.teamId, source.teamId]]), people: new Map([[source.member.email.toLowerCase(), source.member.memberId]]), secret: (path) => ({ $secret: path, decision: "keep" }) }
  const spec = asSpec(resolveSpec(current.spec, resolve))
  const groups = Array.isArray(spec.modelGroups) ? spec.modelGroups.filter(isRecord) : []
  const edited = { ...spec, modelGroups: groups.map((group) => group.id === sourceIds.groupId ? { ...group, description: "Luna, and only Luna" } : group) }
  const grantsBefore = await grantRows(sourceIds.providerId)
  const op = updateOp(area, current, { name: current.name, spec: edited })
  assert.deepEqual(op.changes.map((change) => change.path), [`modelGroups[id=${sourceIds.groupId}].description`])
  const result = await area.apply(ctx, op)
  assert.deepEqual(result.steps, [{ action: "update", target: "modelGroups[Luna only]", detail: "description" }])
  assert.deepEqual(await grantRows(sourceIds.providerId), grantsBefore, "grants untouched")

  // A group edit and a grant to a team that doesn't exist: the provider write is one transaction.
  const now = await exportOne(source, sourceIds.providerId)
  const missingTeam = normalizeDenTypeId("team", "tem_01m0000000000000000000000z")
  const access = Array.isArray(spec.access) ? spec.access.filter(isRecord) : []
  const broken = {
    ...edited,
    modelGroups: groups.map((group) => group.id === sourceIds.groupId ? { ...group, description: "Should not stick" } : group),
    access: [...access, { id: "ipa_new", modelGroup: sourceIds.groupId, credentialSet: sourceIds.setId, audience: "team", team: { $ref: `members.teams/${missingTeam}`, id: missingTeam } }],
  }
  await assert.rejects(area.apply(ctx, updateOp(area, now, { name: now.name, spec: broken })), (error: unknown) => {
    assert.ok(error instanceof ConfigApplyItemError, String(error))
    assert.equal(error.failure.code, "team_not_found")
    assert.equal(error.failure.status, 404)
    assert.equal(error.failure.field, "access")
    assert.equal(error.failure.step?.action, "add")
    assert.deepEqual(error.stepsDone, [], "rolled back: nothing was written")
    return true
  })
  const [group] = await db.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.id, normalizeDenTypeId("gatewayModelGroup", sourceIds.groupId)))
  assert.equal(group?.description, "Luna, and only Luna", "the group edit of the failed item was rolled back")
  // Back to the export.
  await area.apply(ctx, updateOp(area, now, { name: now.name, spec: asSpec(resolveSpec(sourceExport.spec, resolve)) }))
})

test("irreversible: removing a credential set or the provider deletes stored keys", () => {
  const sets = Array.isArray(sourceExport.spec.credentialSets) ? sourceExport.spec.credentialSets : []
  const withoutSet = { ...sourceExport.spec, credentialSets: [], access: [] }
  assert.ok(sets.length > 0)
  const effects = area.irreversible?.(updateOp(area, sourceExport, { name: sourceExport.name, spec: withoutSet })) ?? []
  assert.deepEqual(effects, [`Credential set "Shared key": its stored key and members' sign-ins are deleted (and revoked upstream).`])
  const deleted = area.irreversible?.({ kind: "delete", targetId: sourceExport.id, previous: sourceExport }) ?? []
  assert.equal(deleted.length, 1)
  assert.match(deleted[0] ?? "", /stored keys/)
})

test("create in another org: new ids, team and people refs resolve, unset leaves the set needing a key", async () => {
  const target = await setup("Gateway Blob Clone")
  const { memberId } = await den.join(target.owner, target.orgId, source.member)
  const ctx = await context(target.orgId, target.owner)
  const spec = asSpec(resolveSpec(sourceExport.spec, { teams: new Map([[source.teamId, target.teamId]]), people: new Map([[source.member.email.toLowerCase(), memberId]]), secret: (path) => ({ $secret: path, decision: "unset" }) }))
  const result = await area.apply(ctx, { kind: "create", item: { sourceId: sourceIds.providerId, name: sourceExport.name, spec } })
  assert.notEqual(result.localId, sourceIds.providerId, "the source id is taken on this instance")
  assert.ok(result.warnings?.some((warning) => warning.includes("has no key yet")), JSON.stringify(result.warnings))
  const clone = await exportOne(target, result.localId)
  const cloneSpec = asSpec(clone.spec)
  const sets = Array.isArray(cloneSpec.credentialSets) ? cloneSpec.credentialSets.filter(isRecord) : []
  assert.equal(field(sets[0], "credential", "set"), false, "no key was supplied")
  const access = Array.isArray(cloneSpec.access) ? cloneSpec.access.filter(isRecord) : []
  assert.deepEqual(access.find((grant) => grant.audience === "team")?.team, { $ref: `members.teams/${target.teamId}`, name: "Platform" })
  // Same shape as the source once ids are set aside: groups, models, access, settings.
  const strip = (value: unknown) => JSON.parse(JSON.stringify(withoutTeamIds(value), (key, entry: unknown) => ["id", "modelGroup", "credentialSet", "$secret", "set", "credentialKind"].includes(key) ? undefined : entry))
  assert.deepEqual(strip(cloneSpec), strip(sourceExport.spec))

  const blobItem: ConfigItem = sourceExport
  const match = area.similarity?.(blobItem, clone)
  assert.ok(match && match.score >= 0.85, JSON.stringify(match))
  assert.ok(match.reasons.includes("same provider (openai)") && match.reasons.includes("both use the provider's default address") && match.reasons.some((reason) => reason.startsWith("2/2 models")), JSON.stringify(match))
  const other = area.similarity?.(blobItem, { id: "ipr_x", name: "Something else", spec: { ...cloneSpec, providerId: "anthropic", models: [] } })
  assert.ok(other && other.score < 0.2, JSON.stringify(other))
})

test("round trip: delete, re-create from the export with the source ids, export again", async () => {
  const empty = await setup("Gateway Blob Restore")
  const { memberId } = await den.join(empty.owner, empty.orgId, source.member)
  const sourceCtx = await context(source.orgId, source.owner)
  const final = await exportOne(source, sourceIds.providerId)
  await area.apply(sourceCtx, { kind: "delete", targetId: sourceIds.providerId, previous: final })
  assert.equal((await db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, normalizeDenTypeId("inferenceProvider", sourceIds.providerId)))).length, 0)

  const ctx = await context(empty.orgId, empty.owner)
  const spec = asSpec(resolveSpec(final.spec, { teams: new Map([[source.teamId, empty.teamId]]), people: new Map([[source.member.email.toLowerCase(), memberId]]), secret: (path) => path.endsWith(".credential") ? { $secret: path, decision: "value", value: SECRET } : { $secret: path, decision: "unset" } }))
  const created = await area.apply(ctx, { kind: "create", preferredId: sourceIds.providerId, item: { sourceId: sourceIds.providerId, name: final.name, spec } })
  assert.equal(created.localId, sourceIds.providerId, "provider id reused")
  const again = await exportOne(empty, sourceIds.providerId)
  assert.equal(again.name, final.name)
  assert.deepEqual(withoutTeamIds(again.spec), withoutTeamIds(final.spec), "same spec and child ids (models, groups, sets, grants)")
  assert.equal((await orgCredential(sourceIds.setId))?.secret, SECRET)
  const sets = await db.select().from(GatewayCredentialSetTable).where(inArray(GatewayCredentialSetTable.id, [normalizeDenTypeId("gatewayCredentialSet", sourceIds.setId)]))
  assert.equal(sets[0]?.gateway_provider_id, sourceIds.providerId)
  assert.ok(!JSON.stringify(again).includes(SECRET))
})

test("LiteLLM providers are exported but never applied", async () => {
  const ctx = await context(source.orgId, source.owner)
  const spec = { providerId: "litellm", status: "active", settings: { upstreamBaseUrl: "https://litellm.example.com" }, litellm: { mode: "org", keySource: null, issueStrategy: null, mirrorFallback: null }, modelIds: [], pinnedModelIds: [], models: [], modelGroups: [], credentialSets: [], access: [] }
  await assert.rejects(area.apply(ctx, { kind: "create", item: { name: "LiteLLM", spec } }), /LiteLLM provider/)
})
