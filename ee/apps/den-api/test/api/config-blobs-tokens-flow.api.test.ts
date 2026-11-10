/**
 * Config blobs driven by config tokens (organization API keys of type
 * `config`) through HTTP, as CI would: the public JSON Schema, export,
 * `?dryRun=true`, submit twice for the same scope (D5: the first is
 * superseded), secret values from a config token, scopes (`config:apply`
 * needed to approve, D3: a token that holds it approves and applies), area
 * limits, standard API keys refused, and the 7-day expiry of secret inputs.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem } from "@openwork/types/den/config-blobs"
import { bootDen, field, isRecord, startFakeMcpServer, summary, text, type Call, type Method } from "./harness.js"

const den = await bootDen()
const mcpServer = await startFakeMcpServer({ tools: [{ name: "ping", description: "Ping", text: "pong" }] })
after(async () => {
  await mcpServer.close()
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const repository = await import("../../src/config-blobs/repository.js")
const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")

const SECRETS = { mcp: "sk-tokens-mcp-SECRET-1", header: "hdr-tokens-SECRET-1", newMcp: "sk-tokens-mcp-SECRET-2", newHeader: "hdr-tokens-SECRET-2" }
const DAY_MS = 24 * 60 * 60 * 1000

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

function planItems(plan: ConfigPlan): ConfigPlanItem[] {
  return plan.areas.flatMap((area) => area.items)
}

function areaItems(blob: ConfigBlob, key: string): Array<{ id?: string; name: string; spec: Record<string, unknown> }> {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  const items = isRecord(node) && Array.isArray(node.items) ? node.items : []
  return JSON.parse(JSON.stringify(items))
}

function setAreaItems(blob: ConfigBlob, key: string, items: unknown[]): void {
  let node: unknown = blob.areas
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined
  assert.ok(isRecord(node), `area ${key} in the blob`)
  node.items = items
}

/** Request helper for an API key (it carries its organization). */
function withKey(key: string) {
  return (method: Method, pathname: string, body?: unknown) => den.request(null, method, pathname, { body, headers: { "x-api-key": key } })
}
type Caller = ReturnType<typeof withKey>

async function drive(call: Caller, id: string): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const detail = await call("GET", `/v1/config-blobs/change-requests/${id}`)
    assert.equal(detail.status, 200, summary(detail))
    const current = asSummary(detail)
    if (!["uploaded", "analyzing", "queued", "applying", "stale"].includes(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function storedRow(orgId: string, id: string) {
  const row = await repository.getChangeRequest(normalizeDenTypeId("organization", orgId), normalizeDenTypeId("configChangeRequest", id))
  assert.ok(row, `change request ${id}`)
  return row
}

// ---------------------------------------------------------------------------
// One organization with an MCP connection holding an API key and a secret header.

const owner = await den.signUp("Token Owner")
const { orgId } = await den.createOrg(owner, "Config tokens flow")
const ui = den.as(owner, orgId)

const mcp = await ui("POST", "/v1/mcp-connections", {
  name: "Tokens MCP",
  externalKey: "tokens-mcp",
  url: `${mcpServer.url}/mcp`,
  authType: "apikey",
  credentialMode: "shared",
  apiKey: SECRETS.mcp,
  requestHeaders: [{ name: "X-Tenant", value: SECRETS.header }],
  access: { orgWide: true },
})
assert.equal(mcp.status, 200, summary(mcp))
const mcpId = text(field(mcp.body, "id"), "connection id")

async function createKey(body: Record<string, unknown>): Promise<string> {
  const created = await ui("POST", "/v1/api-keys", body)
  assert.equal(created.status, 201, summary(created))
  return text(field(created.body, "key"), "api key")
}

const SCHEMA_URL = "http://127.0.0.1:8790/v1/config-blobs/schema/1"

test("JSON Schema: public, not behind the flag, envelope plus every area's spec", async () => {
  const schema = await den.request(null, "GET", "/v1/config-blobs/schema/1")
  assert.equal(schema.status, 200, summary(schema))
  assert.equal(field(schema.body, "$id"), SCHEMA_URL)
  assert.equal(field(schema.body, "$schema"), "https://json-schema.org/draft/2020-12/schema")
  assert.deepEqual(field(schema.body, "properties", "format"), { type: "string", const: "openwork.config-blob" })
  const mcpArea = field(schema.body, "properties", "areas", "properties", "connectors", "properties", "mcp")
  assert.ok(isRecord(mcpArea), "connectors.mcp is nested under areas.connectors")
  const spec = field(mcpArea, "properties", "items", "items", "properties", "spec")
  assert.ok(isRecord(spec) && spec.type === "object" && isRecord(spec.properties), "the adapter's spec schema")
  assert.ok("url" in spec.properties, "the MCP spec has its url")
  assert.ok(isRecord(field(schema.body, "properties", "areas", "properties", "settings", "properties", "advanced", "properties", "collections")))
  assert.ok(isRecord(field(schema.body, "properties", "areas", "properties", "desktop-policies")))

  const unknown = await den.request(null, "GET", "/v1/config-blobs/schema/2")
  assert.equal(unknown.status, 404, summary(unknown))
})

let ciKey = ""
let applierKey = ""
let teamsKey = ""
let standardKey = ""
let ci: Caller
let applier: Caller
let exported: ConfigBlob
let edited: ConfigBlob

test("setup: feature on, a CI token, an applier token, an area-limited token and a standard key", async () => {
  const enabled = await den.setFeature(orgId, "configBlobs", true)
  assert.ok(enabled.status < 300, summary(enabled))
  ciKey = await createKey({ name: "CI", type: "config", scopes: ["config:export", "config:submit"] })
  applierKey = await createKey({ name: "Applier", type: "config", scopes: ["config:submit", "config:apply"] })
  teamsKey = await createKey({ name: "Teams only", type: "config", scopes: ["config:export", "config:submit"], areas: ["members.teams"] })
  standardKey = await createKey({ name: "Standard" })
  ci = withKey(ciKey)
  applier = withKey(applierKey)
})

test("a standard API key gets 403 on config-blob routes", async () => {
  const standard = withKey(standardKey)
  for (const [method, path, body] of [
    ["GET", "/v1/config-blobs/areas", undefined],
    ["GET", "/v1/config-blobs/export", undefined],
    ["POST", "/v1/config-blobs/change-requests", { blob: {}, mode: "merge" }],
    ["POST", "/v1/config-blobs/change-requests?dryRun=true", { blob: {}, mode: "merge" }],
    ["GET", "/v1/config-blobs/change-requests", undefined],
  ] as const) {
    const refused = await standard(method, path, body)
    assert.equal(refused.status, 403, `${method} ${path}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), "config_scope_required")
  }
})

test("export with a config token: placeholders, no secret values, $schema points at the public schema", async () => {
  const response = await ci("GET", "/v1/config-blobs/export?areas=connectors.mcp")
  assert.equal(response.status, 200, summary(response))
  for (const secret of Object.values(SECRETS)) assert.ok(!response.text.includes(secret), "no secret value in the export")
  exported = asBlob(response.body)
  assert.deepEqual(exported.scope, ["connectors.mcp"])
  assert.equal(exported.$schema, SCHEMA_URL)
  edited = asBlob(exported)
  const items = areaItems(edited, "connectors.mcp")
  const target = items.find((item) => item.id === mcpId)
  assert.ok(target)
  target.spec.exposeDirectly = !target.spec.exposeDirectly
  setAreaItems(edited, "connectors.mcp", items)
})

test("an area-limited token can't export or submit other areas", async () => {
  const teams = withKey(teamsKey)
  const other = await teams("GET", "/v1/config-blobs/export?areas=connectors.mcp")
  assert.equal(other.status, 403, summary(other))
  assert.equal(field(other.body, "error"), "nothing_to_export")
  const own = await teams("GET", "/v1/config-blobs/export")
  assert.equal(own.status, 200, summary(own))
  assert.deepEqual(asBlob(own.body).scope, ["members.teams"])
  const submitted = await teams("POST", "/v1/config-blobs/change-requests", { blob: edited, mode: "merge" })
  assert.equal(submitted.status, 403, summary(submitted))
  assert.deepEqual(field(submitted.body, "areas"), ["connectors.mcp"])
  const dryRun = await teams("POST", "/v1/config-blobs/change-requests?dryRun=true", { blob: edited, mode: "merge" })
  assert.equal(dryRun.status, 403, summary(dryRun))
})

test("dry run: the plan at once, nothing stored", async () => {
  const before = await ci("GET", "/v1/config-blobs/change-requests")
  assert.equal(before.status, 200, summary(before))
  const response = await ci("POST", "/v1/config-blobs/change-requests?dryRun=true", { blob: edited, mode: "merge" })
  assert.equal(response.status, 200, summary(response))
  assert.equal(field(response.body, "dryRun"), true)
  assert.deepEqual(field(response.body, "errors"), [])
  const planned = asPlan(field(response.body, "plan"))
  assert.equal(planned.summary.update, 1)
  assert.equal(planItems(planned).find((item) => item.op === "update")?.ref, mcpId)
  const afterList = await ci("GET", "/v1/config-blobs/change-requests")
  assert.deepEqual(afterList.body, before.body, "no change request was stored")

  const invalid = await ci("POST", "/v1/config-blobs/change-requests?dryRun=true", { blob: { format: "nope" }, mode: "merge" })
  assert.equal(invalid.status, 400, summary(invalid))
  assert.equal(field(invalid.body, "error"), "invalid_blob")
})

let requestId = ""

test("submit twice for the same scope: the first is superseded (D5)", async () => {
  const first = await ci("POST", "/v1/config-blobs/change-requests", { blob: edited, mode: "merge", title: "CI run 1" })
  assert.equal(first.status, 202, summary(first))
  const firstId = asSummary(first).id
  assert.equal((await drive(ci, firstId)).status, "needs_review")
  const second = await ci("POST", "/v1/config-blobs/change-requests", { blob: edited, mode: "merge", title: "CI run 2" })
  assert.equal(second.status, 202, summary(second))
  requestId = asSummary(second).id
  assert.equal(asSummary(second).createdBy.apiKeyName, "CI")
  const superseded = asSummary(await ci("GET", `/v1/config-blobs/change-requests/${firstId}`))
  assert.equal(superseded.status, "superseded")
  assert.equal((await drive(ci, requestId)).status, "needs_review")
})

test("a token without config:apply can't approve; secret values from a config token are accepted", async () => {
  const planResponse = await ci("GET", `/v1/config-blobs/change-requests/${requestId}/plan`)
  assert.equal(planResponse.status, 200, summary(planResponse))
  let current = asPlan(field(planResponse.body, "plan"))
  const update = planItems(current).find((item) => item.op === "update")
  assert.ok(update?.flags.includes("needs_input"), "the key and header need a decision")

  const refused = await ci("POST", `/v1/config-blobs/change-requests/${requestId}/approve`, { planHash: current.planHash })
  assert.equal(refused.status, 403, summary(refused))
  assert.deepEqual(refused.body, { error: "config_scope_required", scope: "config:apply" })
  const refusedApply = await ci("POST", `/v1/config-blobs/change-requests/${requestId}/apply`, { planHash: current.planHash })
  assert.equal(refusedApply.status, 403, summary(refusedApply))

  const secrets = update?.secrets ?? []
  assert.equal(secrets.length, 2)
  const inputs = await ci("PUT", `/v1/config-blobs/change-requests/${requestId}/inputs`, {
    inputs: secrets.map((secret) => ({ path: secret.path, decision: "value", value: secret.path.endsWith("apiKey") ? SECRETS.newMcp : SECRETS.newHeader })),
  })
  assert.equal(inputs.status, 200, summary(inputs))
  for (const secret of Object.values(SECRETS)) assert.ok(!inputs.text.includes(secret), "secret values are never returned")
  current = asPlan(field(inputs.body, "plan"))
  assert.equal(current.summary.blocking, 0)
  assert.ok((await storedRow(orgId, requestId)).secretInputs?.some((input) => input.decision === "value"))
})

test("a token with config:apply approves and applies (D3); secret inputs are deleted after apply", async () => {
  const planResponse = await applier("GET", `/v1/config-blobs/change-requests/${requestId}/plan`)
  const current = asPlan(field(planResponse.body, "plan"))
  const queued = await applier("POST", `/v1/config-blobs/change-requests/${requestId}/apply`, { planHash: current.planHash })
  assert.equal(queued.status, 200, summary(queued))
  assert.equal(asSummary(queued).status, "queued")
  const applied = await drive(applier, requestId)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))
  assert.equal(applied.approvals.length, 1)
  const row = await storedRow(orgId, requestId)
  assert.equal(row.secretInputs, null)
  assert.equal(row.approvals[0]?.apiKeyId !== undefined, true, "the approval records the token")

  const again = asBlob((await ci("GET", "/v1/config-blobs/export?areas=connectors.mcp")).body)
  const after = areaItems(again, "connectors.mcp").find((item) => item.id === mcpId)
  const wanted = areaItems(edited, "connectors.mcp").find((item) => item.id === mcpId)
  assert.equal(after?.spec.exposeDirectly, wanted?.spec.exposeDirectly)
})

test("secret inputs expire after 7 days: cleared by the worker tick, the request asks for them again", async () => {
  // A fresh export (the apply above changed the connection), with the field flipped back: one update.
  const fresh = await ci("GET", "/v1/config-blobs/export?areas=connectors.mcp")
  assert.equal(fresh.status, 200, summary(fresh))
  const reverted = asBlob(fresh.body)
  const items = areaItems(reverted, "connectors.mcp")
  const target = items.find((item) => item.id === mcpId)
  assert.ok(target)
  target.spec.exposeDirectly = !target.spec.exposeDirectly
  setAreaItems(reverted, "connectors.mcp", items)
  const created = await ui("POST", "/v1/config-blobs/change-requests", { blob: reverted, mode: "merge", title: "Left open" })
  assert.equal(created.status, 202, summary(created))
  const id = asSummary(created).id
  const reviewed = await drive(ci, id)
  assert.equal(reviewed.status, "needs_review", JSON.stringify(reviewed.errors))
  const planned = asPlan(field((await ui("GET", `/v1/config-blobs/change-requests/${id}/plan`)).body, "plan"))
  const secrets = planItems(planned).flatMap((item) => item.secrets ?? [])
  assert.equal(planned.summary.update, 1)
  assert.ok(secrets.length > 0, "the connection's secrets are in the plan")
  const inputs = await ui("PUT", `/v1/config-blobs/change-requests/${id}/inputs`, {
    inputs: secrets.map((secret) => ({ path: secret.path, decision: "value", value: SECRETS.newMcp })),
  })
  assert.equal(inputs.status, 200, summary(inputs))
  assert.ok((await storedRow(orgId, id)).secretInputs)

  // Not yet 7 days old: nothing expires.
  assert.deepEqual(await repository.expireSecretInputs({ now: new Date(Date.now() + 6 * DAY_MS) }), [])
  assert.ok((await storedRow(orgId, id)).secretInputs)

  const tick = await runConfigBlobWorkerOnce({ now: new Date(Date.now() + 8 * DAY_MS) })
  assert.equal(tick.expired, 1)
  const expired = await storedRow(orgId, id)
  assert.equal(expired.secretInputs, null)
  assert.deepEqual(expired.approvals, [])

  const reanalyzed = await drive(ci, id)
  assert.equal(reanalyzed.status, "needs_review", JSON.stringify(reanalyzed.errors))
  const replanned = asPlan(field((await ui("GET", `/v1/config-blobs/change-requests/${id}/plan`)).body, "plan"))
  assert.ok(planItems(replanned).some((item) => item.flags.includes("needs_input")), "the secrets need a decision again")

  const cancelled = await ui("POST", `/v1/config-blobs/change-requests/${id}/cancel`, {})
  assert.equal(cancelled.status, 200, summary(cancelled))
  assert.equal((await storedRow(orgId, id)).secretInputs, null)
})
