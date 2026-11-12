/**
 * Config-blob area `settings.features`, end to end through HTTP: an export
 * lists exactly the features that are on for the organization (its own
 * overrides, and on for everyone), never one that is off or only on for a
 * member; an import by a platform admin turns the missing ones on through the
 * same override /admin sets (with its feature_change history), skipping keys
 * this server doesn't know, doesn't offer, killed or locked off; anyone else
 * is blocked on these items while the rest of the import applies; mirror
 * mode never turns a feature off; and a re-import changes nothing.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { bootDen, field, isRecord, summary, text, type Call, type Session } from "./harness.js"

// Self-hosted (autoRouter is cloud only); the operator locks workbotDocuments off.
const den = await bootDen({ env: { DEN_FEATURE_WORKBOT_DOCUMENTS: "false" } })
after(async () => { await den.close() })
const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const { db } = await import("../../src/db.js")
const { FeatureChangeTable } = await import("@openwork-ee/den-db/schema")
const { and, eq } = await import("@openwork-ee/den-db/drizzle")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { PLATFORM_ADMIN_ONLY_MESSAGE, settingsFeaturesArea } = await import("../../src/config-blobs/areas/settings-features.js")
const { FEATURE_KEYS, featureDefinition } = await import("@openwork/features")

const AREA = "settings.features"
type Api = ReturnType<typeof den.as>

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

function clone<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value))
}

function asSummary(call: Call): ConfigChangeRequestSummary {
  const value = field(call.body, "changeRequest")
  assert.ok(isRecord(value) && typeof value.id === "string", summary(call))
  return clone(value)
}

function asPlan(value: unknown): ConfigPlan {
  assert.ok(isRecord(value) && typeof value.planHash === "string", "a plan")
  return clone(value)
}

function areaItems(blob: ConfigBlob, key: string): FeatureBlobItem[] {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  return clone(isRecord(node) && Array.isArray(node.items) ? node.items : [])
}

type FeatureBlobItem = { id?: string; name: string; spec: Record<string, unknown> }

/** Just this area of an export, plus `extra` items (B's people differ from A's: that is members.people's business). */
function featuresOnly(blob: ConfigBlob, extra: FeatureBlobItem[] = []): ConfigBlob {
  return {
    format: blob.format,
    formatVersion: blob.formatVersion,
    ...(blob.source ? { source: clone(blob.source) } : {}),
    scope: [AREA],
    areas: { settings: { features: { specVersion: 1, items: [...areaItems(blob, AREA), ...extra] } } },
  }
}

function featureItems(plan: ConfigPlan): ConfigPlanItem[] {
  return plan.areas.find((area) => area.area === AREA)?.items ?? []
}

function describe(items: readonly ConfigPlanItem[]): string {
  return JSON.stringify(items.map((item) => ({ ref: item.ref, op: item.op, flags: item.flags, reasons: item.reasons })), null, 1)
}

async function drive(api: Api, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "change request"))
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function upload(api: Api, blob: ConfigBlob, mode: "merge" | "mirror", title: string): Promise<{ id: string; plan: ConfigPlan }> {
  const request = asSummary(await ok(api("POST", "/v1/config-blobs/change-requests", { blob, mode, title }), "upload"))
  const analyzed = await drive(api, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  return { id: request.id, plan: asPlan(field((await ok(api("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan")) }
}

async function freshSession(person: Session): Promise<Session> {
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  return { ...person, token: text(field(signedIn.body, "token"), "session token"), cookie: signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "" }
}

async function applyPlan(person: Session, orgId: string, id: string, plan: ConfigPlan): Promise<ConfigChangeRequestSummary> {
  const fresh = den.as(await freshSession(person), orgId)
  await ok(fresh("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  return drive(fresh, id)
}

async function orgFeatures(api: Api): Promise<Record<string, unknown>> {
  const features = field((await ok(api("GET", "/v1/org"), "org")).body, "features")
  assert.ok(isRecord(features), "features")
  return features
}

// ---------------------------------------------------------------------------
// The deployment's platform admin (allowlisted by the harness) and an ordinary owner.

await ok(den.asPlatformAdmin("GET", "/v1/admin/features"), "the platform admin signs up")
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
assert.equal(signedIn.status, 200, summary(signedIn))
const platformAdmin: Session = {
  token: text(field(signedIn.body, "token"), "platform admin token"),
  cookie: signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "",
  email: `platform-admin+${den.stamp}@example.test`,
  name: "Platform Admin",
  userId: text(field(signedIn.body, "user", "id"), "platform admin id"),
}
const owner = await den.signUp("Features Owner")

const orgA = await den.createOrg(owner, "Features source")
const orgB = await den.createOrg(platformAdmin, "Features target")
const orgC = await den.createOrg(owner, "Features other target")
for (const org of [orgA.orgId, orgB.orgId, orgC.orgId]) assert.equal((await den.setFeature(org, "configBlobs", true)).status, 200)
const apiA = den.as(owner, orgA.orgId)
const apiB = den.as(platformAdmin, orgB.orgId)
const apiC = den.as(owner, orgC.orgId)

// Every feature state this file relies on is set here, never left to the registry default.
/** On for A, off for B and C: the features an import has to turn on. */
const TURNED_ON = ["googleDrivePdfText", "nativeDictation"]
/** Off for every organization here: one A turned off, and one only A's owner has (a member override). */
const TURNED_OFF = ["agentQuestions", "superAdminPermissionSet"]
for (const key of TURNED_ON) {
  assert.equal((await den.setFeature(orgA.orgId, key, true)).status, 200, key)
  for (const org of [orgB.orgId, orgC.orgId]) assert.equal((await den.setFeature(org, key, false)).status, 200, key)
}
for (const key of TURNED_OFF) {
  for (const org of [orgA.orgId, orgB.orgId, orgC.orgId]) assert.equal((await den.setFeature(org, key, false)).status, 200, key)
}
await ok(den.asPlatformAdmin("PUT", "/v1/admin/features/featureIntros", { enabled: true }), "on for everyone")
await ok(den.asPlatformAdmin("PUT", `/v1/admin/organizations/${orgA.orgId}/members/${orgA.owner.memberId}/capabilities`, { capabilities: { agentQuestions: true } }), "member override")
await ok(apiA("POST", "/v1/org/web-origins", { origin: "https://features-source.example.com" }), "web origin")
// Killed everywhere: never exported, and skipped when a file asks for it.
await ok(den.asPlatformAdmin("PUT", "/v1/admin/features/claudeAgentProvider", { killed: true }), "kill switch")

/** What A's export must list: on by default on this deployment or turned on above, minus what is off, killed or locked off. */
const expectedOnForA = FEATURE_KEYS
  .filter((key) => {
    const definition = featureDefinition(key)
    if (!definition.deployments.includes("self_hosted")) return false
    if ([...TURNED_OFF, "claudeAgentProvider", "workbotDocuments"].includes(key)) return false
    return definition.default || ["configBlobs", "featureIntros", ...TURNED_ON].includes(key)
  })
  .map((key): string => key)
  .sort()

let exportedA: ConfigBlob

test("export: exactly the features on for the organization, as { enabled: true }", async () => {
  exportedA = clone<ConfigBlob>((await ok(apiA("GET", "/v1/config-blobs/export"), "export")).body)
  const items = areaItems(exportedA, AREA)
  assert.deepEqual(items.map((item) => item.id), expectedOnForA, JSON.stringify(items))
  for (const key of [...TURNED_OFF, "claudeAgentProvider", "workbotDocuments"]) assert.ok(!items.some((item) => item.id === key), `${key} is off, killed, locked or member-only: never exported`)
  assert.ok(items.every((item) => JSON.stringify(item.spec) === JSON.stringify({ enabled: true })), JSON.stringify(items))
  assert.equal(items.find((item) => item.id === "configBlobs")?.name, "Config import and export")
  assert.ok(exportedA.scope.includes(AREA))
})

test("import by a platform admin turns the missing features on; unknown, unavailable, killed and locked keys are skipped", async () => {
  const blob = featuresOnly(exportedA, [
    { id: "notARealFeature", name: "Not a real feature", spec: { enabled: true } },
    { id: "litellm", name: "LiteLLM", spec: { enabled: true } },
    { id: "autoRouter", name: "Smart routers", spec: { enabled: true } },
    { id: "claudeAgentProvider", name: "Claude Code sign-in", spec: { enabled: true } },
    { id: "workbotDocuments", name: "Workbot documents", spec: { enabled: true } },
  ])
  const { id, plan } = await upload(apiB, blob, "merge", "Features")
  const items = featureItems(plan)
  const op = (ref: string) => items.find((item) => item.ref === ref)
  assert.equal(op("configBlobs")?.op, "unchanged", describe(items))
  assert.equal(op("featureIntros")?.op, "unchanged", "on for everyone already")
  for (const ref of TURNED_ON) {
    assert.equal(op(ref)?.op, "create", describe(items))
    assert.deepEqual(op(ref)?.flags.filter((flag) => flag === "blocked"), [], describe(items))
    assert.match(op(ref)?.irreversible?.[0] ?? "", /^Turns on .+ for everyone in this organization/)
  }
  const skipped = (ref: string) => (op(ref)?.op === "skip" ? op(ref)?.reasons?.join(" ") ?? "" : `not skipped: ${describe(items)}`)
  assert.match(skipped("notARealFeature"), /isn't a feature on this server/)
  assert.match(skipped("litellm"), /no longer a feature flag on this server/)
  assert.match(skipped("autoRouter"), /isn't part of this deployment/)
  assert.match(skipped("claudeAgentProvider"), /kill switch/)
  assert.match(skipped("workbotDocuments"), /locked off by this server's operator \(DEN_FEATURE_WORKBOT_DOCUMENTS\)/)
  assert.equal(plan.summary.blocking, 0, describe(items))

  const applied = await applyPlan(platformAdmin, orgB.orgId, id, plan)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))
  const features = await orgFeatures(apiB)
  assert.equal(features.googleDrivePdfText, true)
  assert.equal(features.nativeDictation, true)
  assert.equal(features.workbotDocuments, false)
  assert.equal(features.claudeAgentProvider, false)
  assert.equal(features.agentQuestions, false, "member overrides never travel")
  assert.equal(features.superAdminPermissionSet, false)
  // The same override /admin sets, with its history: who turned it on.
  const history = await db.select().from(FeatureChangeTable).where(and(eq(FeatureChangeTable.organization_id, orgB.orgId), eq(FeatureChangeTable.scope, "organization")))
  const imported = history.filter((row) => row.feature_key !== "configBlobs" && row.action === "on").map((row) => [row.feature_key, row.action, row.changed_by_user_id]).sort()
  assert.deepEqual(imported, [["googleDrivePdfText", "on", platformAdmin.userId], ["nativeDictation", "on", platformAdmin.userId]])
})

test("anyone else is blocked on the features; the rest of the import still applies", async () => {
  const { id, plan } = await upload(apiC, exportedA, "merge", "Features by a non-admin")
  const items = featureItems(plan)
  const creates = items.filter((item) => item.op === "create")
  assert.deepEqual(creates.map((item) => item.ref).sort(), TURNED_ON, describe(items))
  for (const item of creates) {
    assert.ok(item.flags.includes("blocked"), describe(items))
    assert.ok(item.reasons?.some((reason) => reason.includes(PLATFORM_ADMIN_ONLY_MESSAGE)), describe(items))
  }
  assert.ok(plan.summary.blocking > 0)
  const decided = await ok(apiC("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { skips: creates.map((item) => ({ area: AREA, ref: item.ref })) }), "skip the features")
  const skipped = asPlan(field(decided.body, "plan"))
  assert.equal(skipped.summary.blocking, 0, describe(featureItems(skipped)))
  const applied = await applyPlan(owner, orgC.orgId, id, skipped)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))
  const features = await orgFeatures(apiC)
  assert.equal(features.googleDrivePdfText, false)
  assert.equal(features.nativeDictation, false)
  const origins = await ok(apiC("GET", "/v1/org/web-origins"), "origins")
  assert.ok(origins.text.includes("https://features-source.example.com"), summary(origins))
})

test("a config token acts for its member: one a non-admin made is blocked too, and apply checks again", async () => {
  const created = await ok(apiC("POST", "/v1/api-keys", { name: "Features", type: "config", scopes: ["config:export", "config:submit", "config:apply"] }), "config token")
  const key = text(field(created.body, "key"), "api key")
  const withKey = (method: "GET" | "POST", pathname: string, body?: unknown) => den.request(null, method, pathname, { body, headers: { "x-api-key": key } })
  const request = asSummary(await ok(withKey("POST", "/v1/config-blobs/change-requests", { blob: featuresOnly(exportedA), mode: "merge", title: "By token" }), "submit"))
  const analyzed = await drive(apiC, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  const plan = asPlan(field((await ok(withKey("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan"))
  const creates = featureItems(plan).filter((item) => item.op === "create")
  assert.deepEqual(creates.map((item) => item.ref).sort(), TURNED_ON, describe(featureItems(plan)))
  assert.ok(creates.every((item) => item.flags.includes("blocked") && item.reasons?.some((reason) => reason.includes(PLATFORM_ADMIN_ONLY_MESSAGE))), describe(creates))

  // The apply-time check, as the worker runs it for an approval given with that token.
  const ctx = { db, organizationId: orgC.orgId, actor: { userId: owner.userId, memberId: orgC.owner.memberId, apiKeyId: "tok_features" }, deployment: "self_hosted" as const, features: await getOrganizationFeatures(orgC.orgId) }
  await assert.rejects(settingsFeaturesArea.apply(ctx, { kind: "create", item: { sourceId: "nativeDictation", name: "Dictation", spec: { enabled: true } } }), (error: unknown) => error instanceof Error && error.message === PLATFORM_ADMIN_ONLY_MESSAGE)
  assert.equal((await orgFeatures(apiC)).nativeDictation, false)
})

test("mirror mode never turns a feature off, even when its delete is ticked", async () => {
  const blob: ConfigBlob = {
    format: "openwork.config-blob",
    formatVersion: 1,
    scope: [AREA],
    areas: { settings: { features: { specVersion: 1, items: [{ id: "configBlobs", name: "Config import and export", spec: { enabled: true } }] } } },
  }
  const { id, plan } = await upload(apiB, blob, "mirror", "Mirror features")
  const decided = await ok(apiB("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { deletes: [{ area: AREA, targetId: "nativeDictation" }] }), "tick a delete")
  const ticked = asPlan(field(decided.body, "plan"))
  for (const current of [plan, ticked]) {
    const items = featureItems(current)
    assert.deepEqual(items.filter((item) => item.op === "delete"), [], describe(items))
  }
  const dictation = featureItems(ticked).find((item) => item.target?.id === "nativeDictation")
  assert.ok(dictation?.reasons?.some((reason) => reason.includes("Imports never turn features off.")), describe(featureItems(ticked)))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${id}/cancel`, {}), "cancel")
  assert.equal((await orgFeatures(apiB)).nativeDictation, true)
})

test("re-import: B's own export into B is all unchanged", async () => {
  const exportedB = clone<ConfigBlob>((await ok(apiB("GET", "/v1/config-blobs/export"), "export B")).body)
  assert.deepEqual(areaItems(exportedB, AREA).map((item) => item.id), expectedOnForA, "B now has what A has")
  const { plan } = await upload(apiB, exportedB, "merge", "Own export")
  const items = featureItems(plan)
  assert.ok(items.length === expectedOnForA.length && items.every((item) => item.op === "unchanged"), describe(items))
  const again = await upload(apiB, featuresOnly(exportedA), "merge", "A again")
  assert.ok(featureItems(again.plan).every((item) => item.op === "unchanged"), describe(featureItems(again.plan)))
})
