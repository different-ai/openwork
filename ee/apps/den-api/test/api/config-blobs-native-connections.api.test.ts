/**
 * Config blobs: the organization's built-in provider connections (Google
 * Workspace, Microsoft 365) travel with `connectors.mcp`.
 *
 * 1. An export carries each one with its provider and its OAuth app (client
 *    id, optional features, tenant), the client secret as a placeholder. The
 *    sample Microsoft 365 of a sandbox and a connection nobody gave an OAuth
 *    app stay behind.
 * 2. Imported into an organization that has none, the connection, its access
 *    and its OAuth app exist there; the same file again writes nothing.
 * 3. A new name, new access and a new client id reach the organization that
 *    already has the connection.
 * 4. A file can't turn a built-in connection into an MCP connection, or into
 *    another provider's.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem, ConfigSecretInput } from "@openwork/types/den/config-blobs"
import { bootDen, field, isRecord, list, strings, summary, text, type Call, type Member, type Session } from "./harness.js"

const den = await bootDen()
after(async () => {
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const { db } = await import("../../src/db.js")
const { and, eq } = await import("@openwork-ee/den-db/drizzle")
const { OrgOAuthClientTable } = await import("@openwork-ee/den-db/schema")
const { SANDBOX_MICROSOFT_CLIENT_MARKER } = await import("../../src/capability-sources/sandbox-microsoft-endpoints.js")

const AREAS = "members.teams,connectors.mcp"
const AREA = "connectors.mcp"
const BLOCKING = ["needs_mapping", "ref_unresolved", "drift", "collision.unique", "conflict.identity", "blocked", "needs_input"]
const SECRETS = { google: "fixture-google-client-secret", microsoft: "fixture-microsoft-client-secret", entered: "fixture-secret-typed-by-the-importer" }
const GOOGLE_CLIENT = "fixture-google-client.apps.example"
const GOOGLE_CLIENT_NEXT = "fixture-google-client-2.apps.example"
const MICROSOFT_CLIENT = "0f0f0f0f-1111-4222-8333-444444444444"
const TENANT = "9a9a9a9a-1111-4222-8333-555555555555"

type Api = ReturnType<typeof den.as>

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

function asBlob(value: unknown): ConfigBlob {
  assert.ok(isRecord(value) && value.format === "openwork.config-blob", "a config blob")
  return JSON.parse(JSON.stringify(value))
}

function asSummary(call: Call): ConfigChangeRequestSummary {
  const value = field(call.body, "changeRequest")
  assert.ok(isRecord(value) && typeof value.id === "string", summary(call))
  return JSON.parse(JSON.stringify(value))
}

function asPlan(value: unknown): ConfigPlan {
  assert.ok(isRecord(value) && typeof value.planHash === "string", "a plan")
  return JSON.parse(JSON.stringify(value))
}

const planItems = (plan: ConfigPlan): ConfigPlanItem[] => plan.areas.flatMap((area) => area.items)
const nameOf = (item: ConfigPlanItem) => item.blob?.name ?? item.target?.name ?? ""
const label = (item: ConfigPlanItem) => `${item.area}:${nameOf(item)}:${item.op}`
const writes = (plan: ConfigPlan) => planItems(plan).filter((item) => ["create", "update", "rename", "delete"].includes(item.op))
const blocking = (plan: ConfigPlan) => planItems(plan).filter((item) => item.flags.some((flag) => BLOCKING.includes(flag)))

function describe(items: readonly ConfigPlanItem[]): string {
  return JSON.stringify(items.map((item) => ({ area: item.area, name: nameOf(item), op: item.op, tier: item.matchedBy, flags: item.flags, reasons: item.reasons, fields: item.fields.map((change) => change.path) })), null, 1)
}

async function drive(api: Api, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const current = asSummary(await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "change request"))
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function upload(api: Api, blob: ConfigBlob, title: string): Promise<{ id: string; plan: ConfigPlan }> {
  const request = asSummary(await ok(api("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title }), "upload"))
  const analyzed = await drive(api, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  return { id: request.id, plan: asPlan(field((await ok(api("GET", `/v1/config-blobs/change-requests/${request.id}/plan`), "plan")).body, "plan")) }
}

/** Leaves out every reference the target can't resolve (people of the source who are not members here). */
async function dropOpenReferences(api: Api, id: string, plan: ConfigPlan): Promise<ConfigPlan> {
  const refs = planItems(plan)
    .filter((entry) => entry.flags.includes("ref_unresolved"))
    .flatMap((entry) => (entry.refs ?? [])
      .filter((ref) => ref.resolvedId === null && !ref.via)
      .map((ref) => ({ area: entry.area, ref: entry.ref, path: ref.path, resolution: { drop: true as const } })))
  if (refs.length === 0) return plan
  return asPlan(field((await ok(api("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { refs }), "decisions")).body, "plan"))
}

/** The importer answers every secret the plan asks about: types one in, or keeps the one stored here. */
async function enterSecrets(api: Api, id: string, plan: ConfigPlan, decision: "value" | "keep" = "value"): Promise<{ plan: ConfigPlan; asked: string[] }> {
  const asked = planItems(plan)
    .flatMap((entry) => (entry.op === "create" || entry.op === "update" ? entry.secrets ?? [] : []))
    .filter((secret) => secret.decision === null)
  const inputs = asked.map((secret): ConfigSecretInput => decision === "keep" ? { path: secret.path, decision: "keep" } : { path: secret.path, decision: "value", value: SECRETS.entered })
  if (inputs.length === 0) return { plan, asked: [] }
  const next = asPlan(field((await ok(api("PUT", `/v1/config-blobs/change-requests/${id}/inputs`, { inputs }), "inputs")).body, "plan"))
  return { plan: next, asked: asked.map((secret) => secret.field) }
}

async function apply(api: Api, id: string, plan: ConfigPlan): Promise<ConfigApplyReport> {
  const queued = await ok(api("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: plan.planHash }), "approve and apply")
  assert.equal(asSummary(queued).status, "queued")
  const settled = await drive(api, id)
  const detail = await ok(api("GET", `/v1/config-blobs/change-requests/${id}`), "detail")
  const runs: ConfigApplyReport[] = JSON.parse(JSON.stringify(field(detail.body, "runs") ?? []))
  const run = runs[0]
  assert.ok(run, "one run")
  assert.equal(settled.status, "applied", `${JSON.stringify(settled.errors)}\n${JSON.stringify(run.items.filter((entry) => entry.status === "failed"), null, 1)}`)
  assert.equal(run.counts.failed, 0)
  return run
}

function item(plan: ConfigPlan, name: string): ConfigPlanItem {
  const found = planItems(plan).find((entry) => entry.area === AREA && nameOf(entry) === name)
  assert.ok(found, `${AREA} "${name}" is in the plan: ${describe(planItems(plan))}`)
  return found
}

/** The `connectors.mcp` items of a file, by name. */
function connectionItems(blob: ConfigBlob): Record<string, { id?: string; name: string; spec: Record<string, unknown> }> {
  const area = field(blob.areas, "connectors", "mcp")
  const out: Record<string, { id?: string; name: string; spec: Record<string, unknown> }> = {}
  for (const entry of list(field(area, "items"))) {
    assert.ok(isRecord(entry.spec), "an item has a spec")
    out[text(entry.name, "item name")] = { ...(typeof entry.id === "string" ? { id: entry.id } : {}), name: text(entry.name, "item name"), spec: entry.spec }
  }
  return out
}

async function exportOf(api: Api): Promise<ConfigBlob> {
  const response = await ok(api("GET", `/v1/config-blobs/export?areas=${AREAS}`), "export")
  for (const secret of Object.values(SECRETS)) assert.ok(!response.text.includes(secret), "no secret value in an export")
  return asBlob(response.body)
}

async function addNative(api: Api, body: { nativeProviderKey: string; name: string; oauthClient: { clientId: string; clientSecret?: string; features?: string[] } }): Promise<string> {
  const created = await ok(api("POST", "/v1/mcp-connections", { kind: "native_provider", ...body }), `add ${body.name}`)
  return text(field(created.body, "id"), "connection id")
}

type Connection = { id: string; name: string; nativeProviderKey: unknown; url: unknown; orgWide: unknown; teamIds: string[]; memberIds: string[] }

/** Every connection of the organization, with who can use it. */
async function connections(api: Api): Promise<Record<string, Connection>> {
  const listed = await ok(api("GET", "/v1/mcp-connections?scope=manageable"), "connections")
  const out: Record<string, Connection> = {}
  for (const row of list(field(listed.body, "connections"))) {
    const name = text(row.name, "connection name")
    out[name] = {
      id: text(row.id, "connection id"),
      name,
      nativeProviderKey: row.nativeProviderKey,
      url: row.url,
      orgWide: field(row.access, "orgWide"),
      teamIds: strings(field(row.access, "teamIds")),
      memberIds: strings(field(row.access, "memberIds")),
    }
  }
  return out
}

/** The OAuth app of a built-in connection, as the dashboard reads it, and whether its secret is stored. */
async function oauthApp(api: Api, connectionId: string) {
  const detail = await ok(api("GET", `/v1/oauth-providers/${connectionId}/client`), "oauth app")
  const [row] = await db.select({ secret: OrgOAuthClientTable.clientSecret }).from(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.providerId, connectionId))
  return {
    configured: field(detail.body, "configured"),
    clientId: field(detail.body, "clientId"),
    features: strings(field(detail.body, "features")).sort(),
    tenantId: field(detail.body, "tenantId"),
    hasSecret: Boolean(row?.secret),
  }
}

/** The id a team has in this organization, read from its own export. */
async function teamIdByName(api: Api, name: string): Promise<string> {
  const teams = list(field((await exportOf(api)).areas, "members", "teams", "items"))
  const found = teams.find((team) => team.name === name)
  assert.ok(found, `team "${name}" exists: ${JSON.stringify(teams.map((team) => team.name))}`)
  return text(found.id, "team id")
}

// ---------------------------------------------------------------------------
// The source: Google Workspace for one team, Microsoft 365 bound to a tenant,
// and two built-in connections that must stay behind.

const ada = await den.signUp("Ada Owner")
const source = await den.createOrg(ada, "Built-in source")
const apiA = den.as(ada, source.orgId)
const cal: Member = await den.newMember(ada, source.orgId, "Cal Member")
const salesA = await den.createTeam(ada, source.orgId, "Sales", [cal.memberId])

const googleA = await addNative(apiA, { nativeProviderKey: "google-workspace", name: "Google Workspace", oauthClient: { clientId: GOOGLE_CLIENT, clientSecret: SECRETS.google, features: ["gmailRead", "calendarRead"] } })
await ok(apiA("PUT", `/v1/mcp-connections/${googleA}/access`, { access: { orgWide: false, memberIds: [], teamIds: [salesA] } }), "google access")
const microsoftA = await addNative(apiA, { nativeProviderKey: "microsoft-365", name: "Microsoft 365", oauthClient: { clientId: MICROSOFT_CLIENT, clientSecret: SECRETS.microsoft } })
await ok(apiA("POST", `/v1/oauth-providers/${microsoftA}/client`, { tenantId: TENANT }), "microsoft tenant")

// A connection whose OAuth app is gone, and one that carries the marker only a sandbox's setup writes.
const orphanA = await addNative(apiA, { nativeProviderKey: "google-workspace", name: "Google without an app", oauthClient: { clientId: "fixture-orphan-client" } })
await db.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.providerId, orphanA))
const sampleA = await addNative(apiA, { nativeProviderKey: "microsoft-365", name: "Sample Microsoft 365", oauthClient: { clientId: "fixture-sample-client" } })
await db.update(OrgOAuthClientTable).set({ extra: { [SANDBOX_MICROSOFT_CLIENT_MARKER]: true } }).where(and(eq(OrgOAuthClientTable.providerId, sampleA)))

const exported = await exportOf(apiA)

const bea = await den.signUp("Bea Importer")
const target = await den.createOrg(bea, "Built-in target")
const apiB = den.as(bea, target.orgId)

test("an export carries each built-in connection with its OAuth app, and leaves the sample and the app-less one behind", () => {
  const items = connectionItems(exported)
  assert.deepEqual(Object.keys(items).sort(), ["Google Workspace", "Microsoft 365"])

  const google = items["Google Workspace"]
  assert.ok(google)
  const googleNative = google.spec.native
  assert.ok(isRecord(googleNative) && isRecord(googleNative.client), JSON.stringify(google.spec))
  assert.equal(googleNative.provider, "google-workspace")
  assert.equal(googleNative.client.clientId, GOOGLE_CLIENT)
  assert.deepEqual(googleNative.client.features, ["calendarRead", "gmailRead"])
  assert.equal(googleNative.client.tenantId, null)
  // A placeholder that says the source had a secret, never the secret.
  assert.ok(isRecord(googleNative.client.clientSecret) && typeof googleNative.client.clientSecret.$secret === "string", JSON.stringify(googleNative.client))
  assert.equal(googleNative.client.clientSecret.set, true)
  // The sign-in settings are Google's own: nothing an admin configured.
  assert.equal(google.spec.oauth, null)
  assert.equal(google.spec.authType, "oauth")
  assert.equal(field(google.spec.access, "orgWide"), false)

  const microsoft = items["Microsoft 365"]
  assert.ok(microsoft)
  assert.equal(field(microsoft.spec.native, "provider"), "microsoft-365")
  assert.equal(field(microsoft.spec.native, "client", "clientId"), MICROSOFT_CLIENT)
  assert.equal(field(microsoft.spec.native, "client", "tenantId"), TENANT)
  assert.equal(field(microsoft.spec.access, "orgWide"), true)
})

test("an organization with none gets the connections, their access and their OAuth apps; the same file again writes nothing", async () => {
  const uploaded = await upload(apiB, exported, "Import")
  assert.equal(item(uploaded.plan, "Google Workspace").op, "create", describe(planItems(uploaded.plan)))
  assert.equal(item(uploaded.plan, "Microsoft 365").op, "create", describe(planItems(uploaded.plan)))
  const dropped = await dropOpenReferences(apiB, uploaded.id, uploaded.plan)
  const entered = await enterSecrets(apiB, uploaded.id, dropped)
  assert.deepEqual(entered.asked.sort(), ["native.client.clientSecret", "native.client.clientSecret"], "both client secrets are asked for")
  assert.deepEqual(blocking(entered.plan).map(label), [], describe(blocking(entered.plan)))
  const run = await apply(apiB, uploaded.id, entered.plan)
  assert.deepEqual(run.items.filter((entry) => entry.area === AREA).flatMap((entry) => entry.warnings), [])

  const now = await connections(apiB)
  assert.deepEqual(Object.keys(now).sort(), ["Google Workspace", "Microsoft 365"])
  const google = now["Google Workspace"]
  const microsoft = now["Microsoft 365"]
  assert.ok(google && microsoft)
  assert.equal(google.nativeProviderKey, "google-workspace")
  assert.equal(microsoft.nativeProviderKey, "microsoft-365")
  // The team of this organization, not the source's.
  const salesB = await teamIdByName(apiB, "Sales")
  assert.notEqual(salesB, salesA)
  assert.deepEqual({ orgWide: google.orgWide, teamIds: google.teamIds, memberIds: google.memberIds }, { orgWide: false, teamIds: [salesB], memberIds: [] })
  assert.equal(microsoft.orgWide, true)

  assert.deepEqual(await oauthApp(apiB, google.id), { configured: true, clientId: GOOGLE_CLIENT, features: ["calendarRead", "gmailRead"], tenantId: null, hasSecret: true })
  // No features were chosen for Microsoft 365: both sides read the provider's defaults.
  const microsoftApp = await oauthApp(apiB, microsoft.id)
  assert.deepEqual(microsoftApp, await oauthApp(apiA, microsoftA))
  assert.deepEqual({ clientId: microsoftApp.clientId, tenantId: microsoftApp.tenantId, hasSecret: microsoftApp.hasSecret }, { clientId: MICROSOFT_CLIENT, tenantId: TENANT, hasSecret: true })

  // What it exports now is what it was given.
  const back = connectionItems(await exportOf(apiB))
  assert.deepEqual(field(back["Google Workspace"]?.spec.native, "client", "features"), ["calendarRead", "gmailRead"])
  assert.equal(field(back["Microsoft 365"]?.spec.native, "client", "tenantId"), TENANT)

  const again = await upload(apiB, exported, "Again")
  assert.deepEqual(blocking(again.plan).map(label), [], describe(blocking(again.plan)))
  assert.deepEqual(writes(again.plan).map(label), [], describe(writes(again.plan)))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${again.id}/cancel`, {}), "cancel")
})

test("a new name, new access and a new client id reach the organization that already has the connection", async () => {
  await ok(apiA("PUT", `/v1/mcp-connections/${googleA}/access`, { access: { orgWide: true, memberIds: [], teamIds: [] } }), "google org-wide")
  await ok(apiA("POST", `/v1/oauth-providers/${googleA}/client`, { clientId: GOOGLE_CLIENT_NEXT, clientSecret: SECRETS.google, features: ["gmailRead"] }), "google client")
  const before = (await connections(apiB))["Google Workspace"]
  assert.ok(before)

  const file = await exportOf(apiA)
  // The source has no route that renames a built-in connection; the file is where its name changes.
  for (const entry of list(field(file.areas, "connectors", "mcp", "items"))) {
    if (entry.name === "Google Workspace") entry.name = "Google Workspace (company)"
  }
  const uploaded = await upload(apiB, file, "Update")
  const google = item(uploaded.plan, "Google Workspace (company)")
  assert.ok(["update", "rename"].includes(google.op), describe([google]))
  assert.equal(google.target?.name, "Google Workspace", describe([google]))
  for (const path of ["access.orgWide", "access.teams", "native.client.clientId", "native.client.features"]) {
    assert.ok(google.fields.some((change) => change.path === path), `${path} changes: ${describe([google])}`)
  }
  assert.equal(item(uploaded.plan, "Microsoft 365").op, "unchanged", describe(planItems(uploaded.plan)))
  const dropped = await dropOpenReferences(apiB, uploaded.id, uploaded.plan)
  // The secret stored here stays: the file never carries one.
  const entered = await enterSecrets(apiB, uploaded.id, dropped, "keep")
  assert.deepEqual(blocking(entered.plan).map(label), [], describe(blocking(entered.plan)))
  await apply(apiB, uploaded.id, entered.plan)

  const after = (await connections(apiB))["Google Workspace (company)"]
  assert.ok(after, "renamed")
  assert.equal(after.id, before.id, "the same connection, updated")
  assert.deepEqual({ orgWide: after.orgWide, teamIds: after.teamIds }, { orgWide: true, teamIds: [] })
  assert.deepEqual([after.nativeProviderKey, after.url], [before.nativeProviderKey, before.url], "its provider and URL are untouched")
  assert.deepEqual(await oauthApp(apiB, after.id), { configured: true, clientId: GOOGLE_CLIENT_NEXT, features: ["gmailRead"], tenantId: null, hasSecret: true })
  assert.equal(Object.keys(await connections(apiB)).length, 2, "nothing was created")
})

test("a file can't turn a built-in connection into an MCP connection or into another provider's", async () => {
  const file = await exportOf(apiA)

  const asMcp: ConfigBlob = JSON.parse(JSON.stringify(file))
  for (const entry of list(field(asMcp.areas, "connectors", "mcp", "items"))) {
    if (entry.name === "Google Workspace" && isRecord(entry.spec)) delete entry.spec.native
  }
  const first = await upload(apiB, asMcp, "As an MCP connection")
  const turned = item(first.plan, "Google Workspace")
  assert.equal(turned.target?.name, "Google Workspace (company)", describe([turned]))
  assert.ok(turned.flags.includes("blocked"), describe([turned]))
  assert.match((turned.reasons ?? []).join("\n"), /"Google Workspace \(company\)" is a built-in google-workspace connection here; an import can't turn it into an MCP connection/)
  const refused = await apiB("POST", `/v1/config-blobs/change-requests/${first.id}/apply`, { planHash: first.plan.planHash })
  assert.ok(refused.status >= 400, summary(refused))
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${first.id}/cancel`, {}), "cancel")

  const otherProvider: ConfigBlob = JSON.parse(JSON.stringify(file))
  const area = field(otherProvider.areas, "connectors", "mcp")
  assert.ok(isRecord(area))
  area.items = list(area.items).filter((entry) => entry.name === "Google Workspace")
  for (const entry of list(area.items)) {
    if (isRecord(entry.spec) && isRecord(entry.spec.native)) entry.spec.native.provider = "microsoft-365"
  }
  const second = await upload(apiB, otherProvider, "Another provider")
  const moved = item(second.plan, "Google Workspace")
  assert.ok(moved.flags.includes("blocked"), describe([moved]))
  assert.match((moved.reasons ?? []).join("\n"), /A built-in connection's provider can't change/)
  await ok(apiB("POST", `/v1/config-blobs/change-requests/${second.id}/cancel`, {}), "cancel")

  const now = await connections(apiB)
  assert.deepEqual(Object.values(now).map((connection) => `${connection.name}:${connection.nativeProviderKey}`).sort(), ["Google Workspace (company):google-workspace", "Microsoft 365:microsoft-365"])
})
