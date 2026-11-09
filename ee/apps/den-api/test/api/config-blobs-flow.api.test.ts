/**
 * Config blobs end to end through HTTP: export, edit, upload, analysis
 * (worker driven in-process), decisions and secret inputs, approval, apply,
 * re-export, import into a second organization on the same instance (ids
 * taken → aliases), idempotent re-import, revert, drift → stale, the
 * per-organization apply lock, and the feature gate.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem, ConfigSecretInput } from "@openwork/types/den/config-blobs"
import { bootDen, field, isRecord, startFakeMcpServer, summary, text, type Call } from "./harness.js"

// Audit capture on (self-hosted entitlement) so the apply's job operation is recorded.
const den = await bootDen({ env: { DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
const mcpServer = await startFakeMcpServer({ tools: [{ name: "ping", description: "Ping", text: "pong" }] })
after(async () => {
  await mcpServer.close()
  await den.close()
})

const { runConfigBlobWorkerOnce } = await import("../../src/config-blobs/worker.js")
const repository = await import("../../src/config-blobs/repository.js")
const { applyClaimedChangeRequest } = await import("../../src/config-blobs/service.js")
const { client } = await import("../../src/db.js")

const SECRETS = { byok: "sk-flow-byok-SECRET-1", byokB: "sk-flow-byok-SECRET-2", mcp: "sk-flow-mcp-SECRET-1", header: "hdr-flow-SECRET-1" }

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

function describePlan(plan: ConfigPlan): string {
  return JSON.stringify(planItems(plan).filter((item) => item.op !== "unchanged" && item.op !== "untouched").map((item) => ({ area: item.area, ref: item.ref, op: item.op, flags: item.flags, reasons: item.reasons, fields: item.fields.map((change) => change.path), matchedBy: item.matchedBy })), null, 1)
}

/** `areas[a][b].items` of a blob, by area key. */
function areaItems(blob: ConfigBlob, key: string): Array<{ id?: string; name: string; spec: Record<string, unknown>; rev?: string }> {
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

async function drive(call: ReturnType<typeof den.as>, id: string, done: (status: string) => boolean = (status) => !["uploaded", "analyzing", "queued", "applying", "stale"].includes(status)): Promise<ConfigChangeRequestSummary> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await runConfigBlobWorkerOnce()
    const detail = await call("GET", `/v1/config-blobs/change-requests/${id}`)
    assert.equal(detail.status, 200, summary(detail))
    const current = asSummary(detail)
    if (done(current.status)) return current
  }
  throw new Error(`change request ${id} never settled`)
}

async function plan(call: ReturnType<typeof den.as>, id: string): Promise<ConfigPlan> {
  const response = await call("GET", `/v1/config-blobs/change-requests/${id}/plan`)
  assert.equal(response.status, 200, summary(response))
  return asPlan(field(response.body, "plan"))
}

async function rows(sql: string, params: string[]): Promise<Record<string, unknown>[]> {
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [result] = await client.query(sql, params)
  const entries: unknown[] = Array.isArray(result) ? result : []
  return entries.filter(isRecord)
}

/** Actions of the audit job operation of one apply (kind config_blobs.apply, scope = change request id). */
async function jobActions(changeRequestId: string): Promise<string[]> {
  const events = await rows("SELECT e.action FROM audit_event e JOIN audit_operation o ON o.id = e.operation_id WHERE o.kind = 'config_blobs.apply' AND o.scope = ?", [changeRequestId])
  return events.map((event) => String(event.action))
}

// ---------------------------------------------------------------------------
// Source organization: a team, a BYOK provider with a key, an MCP connection with a key and header.

const owner = await den.signUp("Flow Owner")
const orgA = await den.createOrg(owner, "Flow source")
const orgB = await den.createOrg(owner, "Flow clone")
const teammate = await den.newMember(owner, orgA.orgId, "Flow Teammate")
const apiA = den.as(owner, orgA.orgId)
const apiB = den.as(owner, orgB.orgId)
const teamA = await den.createTeam(owner, orgA.orgId, "Platform", [teammate.memberId])

const byok = await apiA("POST", "/v1/llm-providers", {
  name: "Acme LLM",
  source: "custom",
  customConfig: { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", env: ["ACME_API_KEY"], api: "https://llm.example.test/v1", models: [{ id: "acme-1", name: "Acme One" }] },
  apiKey: SECRETS.byok,
  teamIds: [teamA],
})
assert.equal(byok.status, 201, summary(byok))
const byokId = text(field(byok.body, "llmProvider", "id"), "provider id")

const mcp = await apiA("POST", "/v1/mcp-connections", {
  name: "Docs MCP",
  externalKey: "docs-mcp",
  url: `${mcpServer.url}/mcp`,
  authType: "apikey",
  credentialMode: "shared",
  apiKey: SECRETS.mcp,
  requestHeaders: [{ name: "X-Tenant", value: SECRETS.header }],
  access: { orgWide: false, teamIds: [teamA], memberIds: [teammate.memberId] },
})
assert.equal(mcp.status, 200, summary(mcp))
const mcpId = text(field(mcp.body, "id"), "connection id")

test("feature off: every config-blob route answers 404", async () => {
  const areas = await apiA("GET", "/v1/config-blobs/areas")
  assert.equal(areas.status, 404, summary(areas))
  assert.equal(field(areas.body, "error"), "feature_disabled")
  const exported = await apiA("GET", "/v1/config-blobs/export")
  assert.equal(exported.status, 404)
  for (const org of [orgA.orgId, orgB.orgId]) {
    const enabled = await den.setFeature(org, "configBlobs", true)
    assert.ok(enabled.status < 300, summary(enabled))
  }
})

let exported: ConfigBlob
let firstRequestId = ""

test("export: attachment, every area, placeholders but no secret values", async () => {
  const areas = await apiA("GET", "/v1/config-blobs/areas")
  assert.equal(areas.status, 200, summary(areas))
  assert.ok(Array.isArray(field(areas.body, "areas")))

  const response = await apiA("GET", "/v1/config-blobs/export")
  assert.equal(response.status, 200, summary(response))
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="openwork-config-/)
  for (const secret of Object.values(SECRETS)) assert.ok(!response.text.includes(secret), "no secret value in the export")
  exported = asBlob(response.body)
  assert.equal(exported.source?.organization.id, orgA.orgId)
  assert.ok(exported.scope.includes("connectors.mcp") && exported.scope.includes("ai-gateway.byok") && exported.scope.includes("members.teams"))
  assert.ok((exported.secrets ?? []).some((entry) => entry.path === `connectors.mcp/${mcpId}/apiKey` && entry.set))
  const docs = areaItems(exported, "connectors.mcp").find((item) => item.id === mcpId)
  assert.equal(docs?.spec.exposeDirectly, false)
})

test("edit one field, upload, analyze: exactly one update; inputs, approve, apply", async () => {
  const edited = asBlob(exported)
  const docs = areaItems(edited, "connectors.mcp")
  const target = docs.find((item) => item.id === mcpId)
  assert.ok(target)
  target.spec.exposeDirectly = true
  setAreaItems(edited, "connectors.mcp", docs)

  const created = await apiA("POST", "/v1/config-blobs/change-requests", { blob: edited, mode: "merge", title: "Token scheme" })
  assert.equal(created.status, 202, summary(created))
  const request = asSummary(created)
  assert.equal(request.status, "uploaded")
  firstRequestId = request.id

  const analyzed = await drive(apiA, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  let current = await plan(apiA, request.id)
  assert.equal(current.summary.update, 1, describePlan(current))
  assert.equal(current.summary.create + current.summary.delete + current.summary.rename, 0, describePlan(current))
  const update = planItems(current).find((item) => item.op === "update")
  assert.equal(update?.ref, mcpId)
  assert.deepEqual(update?.fields.map((change) => change.path), ["exposeDirectly"])
  assert.ok(update?.flags.includes("needs_input"), "the shared key and header need a decision")

  const blocked = await apiA("POST", `/v1/config-blobs/change-requests/${request.id}/approve`, { planHash: current.planHash })
  assert.equal(blocked.status, 409, summary(blocked))

  const inputs = await apiA("PUT", `/v1/config-blobs/change-requests/${request.id}/inputs`, {
    inputs: (update?.secrets ?? []).map((secret) => ({ path: secret.path, decision: "keep" })),
  })
  assert.equal(inputs.status, 200, summary(inputs))
  current = asPlan(field(inputs.body, "plan"))
  assert.equal(current.summary.blocking, 0, describePlan(current))

  const approved = await apiA("POST", `/v1/config-blobs/change-requests/${request.id}/approve`, { planHash: current.planHash })
  assert.equal(approved.status, 200, summary(approved))
  assert.equal(asSummary(approved).status, "approved")
  const queued = await apiA("POST", `/v1/config-blobs/change-requests/${request.id}/apply`, {})
  assert.equal(queued.status, 200, summary(queued))
  assert.equal(asSummary(queued).status, "queued")

  const applied = await drive(apiA, request.id)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))
  const [row] = await rows("SELECT expose_directly FROM external_mcp_connection WHERE id = ?", [mcpId])
  assert.equal(Number(row?.expose_directly), 1)

  const again = asBlob((await apiA("GET", "/v1/config-blobs/export")).body)
  for (const key of exported.scope) {
    const before = areaItems(edited, key).map((item) => ({ id: item.id, name: item.name, spec: item.spec }))
    const after = areaItems(again, key).map((item) => ({ id: item.id, name: item.name, spec: item.spec }))
    assert.deepEqual(after, before, `${key} after apply equals the edited blob`)
  }
  const detail = await apiA("GET", `/v1/config-blobs/change-requests/${request.id}`)
  assert.ok(Array.isArray(field(detail.body, "report", "items")))
  const snapshot = await apiA("GET", `/v1/config-blobs/change-requests/${request.id}/before-snapshot`)
  assert.equal(snapshot.status, 200, summary(snapshot))
  assert.equal(areaItems(asBlob(snapshot.body), "connectors.mcp").find((item) => item.id === mcpId)?.spec.exposeDirectly, false)

  const actions = await jobActions(request.id)
  assert.deepEqual(actions.filter((action) => action.startsWith("config_change_request.")).sort(), ["config_change_request.apply_completed", "config_change_request.apply_started"])
  const audit = await den.auditStorageText()
  for (const secret of Object.values(SECRETS)) assert.ok(!audit.includes(secret), "no secret in the audit log")
})

test("revert: a new change request from the before-snapshot restores the old value", async () => {
  const reverted = await apiA("POST", `/v1/config-blobs/change-requests/${firstRequestId}/revert`, {})
  assert.equal(reverted.status, 201, summary(reverted))
  const request = asSummary(reverted)
  assert.equal(request.source, "revert")
  assert.equal(request.revertsChangeRequestId, firstRequestId)
  const analyzed = await drive(apiA, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  const current = await plan(apiA, request.id)
  assert.equal(current.mode, "mirror")
  assert.equal(current.summary.update, 1, describePlan(current))
  assert.equal(current.summary.delete + current.summary.create, 0, describePlan(current))
  assert.equal(current.summary.blocking, 0, describePlan(current))
  const queued = await apiA("POST", `/v1/config-blobs/change-requests/${request.id}/apply`, { planHash: current.planHash })
  assert.equal(queued.status, 200, summary(queued))
  const applied = await drive(apiA, request.id)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))
  const [row] = await rows("SELECT expose_directly FROM external_mcp_connection WHERE id = ?", [mcpId])
  assert.equal(Number(row?.expose_directly), 0)
  const original = asSummary(await apiA("GET", `/v1/config-blobs/change-requests/${firstRequestId}`))
  assert.equal(original.revertedByChangeRequestId, request.id)
})

test("import into a second organization on the same instance: new ids, aliases, secrets and a confirmed match", async () => {
  // A provider in the clone that looks like the source's: a proposed match the admin confirms.
  const similar = await apiB("POST", "/v1/llm-providers", {
    name: "Acme LLM (old)",
    source: "custom",
    customConfig: { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", env: ["ACME_API_KEY"], api: "https://llm.example.test/v1", models: [{ id: "acme-1", name: "Acme One" }] },
    apiKey: SECRETS.byokB,
    allMembers: true,
  })
  assert.equal(similar.status, 201, summary(similar))
  const similarId = text(field(similar.body, "llmProvider", "id"), "clone provider id")

  const source = asBlob((await apiA("GET", "/v1/config-blobs/export")).body)
  const created = await apiB("POST", "/v1/config-blobs/change-requests", { blob: source, mode: "merge", title: "Clone" })
  assert.equal(created.status, 202, summary(created))
  const request = asSummary(created)
  assert.equal((await drive(apiB, request.id)).status, "needs_review")
  let current = await plan(apiB, request.id)
  const proposed = planItems(current).find((item) => item.area === "ai-gateway.byok" && item.ref === byokId)
  assert.ok(proposed?.flags.includes("needs_mapping"), describePlan(current))
  assert.ok(proposed?.candidates?.some((candidate) => candidate.id === similarId), describePlan(current))

  const decided = await apiB("PUT", `/v1/config-blobs/change-requests/${request.id}/decisions`, {
    matches: [{ area: "ai-gateway.byok", ref: byokId, targetId: similarId }],
  })
  assert.equal(decided.status, 200, summary(decided))
  current = asPlan(field(decided.body, "plan"))
  const inputs: ConfigSecretInput[] = planItems(current).flatMap((item) => (item.op === "create" || item.op === "update" ? item.secrets ?? [] : []))
    .filter((secret) => secret.decision === null)
    .map((secret): ConfigSecretInput => secret.sourceHadValue
      ? { path: secret.path, decision: "value", value: secret.path.includes("ai-gateway.byok") ? SECRETS.byokB : secret.field.includes("requestHeaders") ? SECRETS.header : SECRETS.mcp }
      : { path: secret.path, decision: "unset" })
  const supplied = await apiB("PUT", `/v1/config-blobs/change-requests/${request.id}/inputs`, { inputs })
  assert.equal(supplied.status, 200, summary(supplied))
  current = asPlan(field(supplied.body, "plan"))
  assert.equal(current.summary.blocking, 0, describePlan(current))
  assert.ok(!JSON.stringify(supplied.body).includes(SECRETS.mcp), "inputs are write-only")

  const queued = await apiB("POST", `/v1/config-blobs/change-requests/${request.id}/apply`, { planHash: current.planHash })
  assert.equal(queued.status, 200, summary(queued))
  const applied = await drive(apiB, request.id)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))

  const [team] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = ?", [orgB.orgId, "Platform"])
  assert.ok(team && team.id !== teamA, "the team got a new id: the source id is taken on this instance")
  const aliases = await rows("SELECT area, source_id, local_id FROM config_blob_alias WHERE organization_id = ?", [orgB.orgId])
  assert.ok(aliases.some((alias) => alias.area === "members.teams" && alias.source_id === teamA && alias.local_id === team.id), JSON.stringify(aliases))
  assert.ok(aliases.some((alias) => alias.area === "ai-gateway.byok" && alias.source_id === byokId && alias.local_id === similarId), JSON.stringify(aliases))
  const actions = await jobActions(request.id)
  assert.ok(actions.includes("config_change_request.apply_completed"), JSON.stringify(actions))
  assert.ok(actions.some((action) => !action.startsWith("config_change_request.")), `domain changes join the job operation: ${JSON.stringify(actions)}`)
  const [secretRow] = await rows("SELECT secret_inputs FROM config_change_request WHERE id = ?", [request.id])
  assert.equal(secretRow?.secret_inputs, null, "secret inputs are deleted after apply")

  // The same blob again: everything matches (ids → aliases), nothing to do.
  const again = await apiB("POST", "/v1/config-blobs/change-requests", { blob: source, mode: "merge", title: "Clone again" })
  assert.equal(again.status, 202, summary(again))
  const second = asSummary(again)
  assert.equal((await drive(apiB, second.id)).status, "needs_review")
  const replay = await plan(apiB, second.id)
  const changed = planItems(replay).filter((item) => item.op !== "unchanged" && item.op !== "untouched")
  assert.deepEqual(changed.map((item) => `${item.area}:${item.op}`), [], describePlan(replay))
  assert.ok(planItems(replay).some((item) => item.matchedBy === "alias"), "re-imports match through aliases")
  const cancelled = await apiB("POST", `/v1/config-blobs/change-requests/${second.id}/cancel`, {})
  assert.equal(asSummary(cancelled).status, "cancelled")
})

test("drift: a change on the target after approval makes the request stale, then needs review again", async () => {
  const blob = asBlob((await apiA("GET", "/v1/config-blobs/export?areas=members.teams")).body)
  const teams = areaItems(blob, "members.teams")
  const platform = teams.find((item) => item.id === teamA)
  assert.ok(platform)
  platform.name = "Platform Core"
  setAreaItems(blob, "members.teams", teams)
  const created = asSummary(await apiA("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge" }))
  assert.equal((await drive(apiA, created.id)).status, "needs_review")
  const current = await plan(apiA, created.id)
  assert.equal(current.summary.rename, 1, describePlan(current))
  const approved = await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/approve`, { planHash: current.planHash })
  assert.equal(asSummary(approved).status, "approved")

  const renamed = await apiA("PATCH", `/v1/teams/${teamA}`, { name: "Platform Renamed" })
  assert.equal(renamed.status, 200, summary(renamed))
  const queued = await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/apply`, {})
  assert.equal(asSummary(queued).status, "queued")
  const [claim] = [await repository.claimNextApply()]
  assert.ok(claim && claim.id === created.id)
  assert.equal(await applyClaimedChangeRequest(claim), "stale")
  const settled = await drive(apiA, created.id)
  assert.equal(settled.status, "needs_review")
  assert.deepEqual(settled.approvals, [])
  const [team] = await rows("SELECT name FROM team WHERE id = ?", [teamA])
  assert.equal(team?.name, "Platform Renamed", "nothing was applied")
  await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/cancel`, {})
})

test("one apply per organization: a second queued request waits, then goes stale", async () => {
  const blob = asBlob((await apiA("GET", "/v1/config-blobs/export?areas=members.teams")).body)
  const teams = areaItems(blob, "members.teams")
  const upload = async (name: string) => {
    const copy = asBlob(blob)
    const items = teams.map((item) => (item.id === teamA ? { ...item, name } : item))
    setAreaItems(copy, "members.teams", items)
    const created = asSummary(await apiA("POST", "/v1/config-blobs/change-requests", { blob: copy, mode: "merge" }))
    assert.equal((await drive(apiA, created.id)).status, "needs_review")
    return created.id
  }
  const queue = async (id: string) => {
    const current = await plan(apiA, id)
    const queued = await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })
    assert.equal(asSummary(queued).status, "queued", summary(queued))
  }
  const first = await upload("Platform One")
  const second = await upload("Platform Two")
  await queue(first)
  await queue(second)
  const claim = await repository.claimNextApply()
  assert.ok(claim && claim.id === first)
  assert.equal(await repository.claimNextApply(), null, "the organization is busy: the second request waits")
  assert.equal(await applyClaimedChangeRequest(claim), "applied")
  const after = asSummary(await apiA("GET", `/v1/config-blobs/change-requests/${second}`))
  assert.equal(after.status, "stale", "planned against the state before the first apply")
  assert.equal((await drive(apiA, second)).status, "needs_review")
  const [team] = await rows("SELECT name FROM team WHERE id = ?", [teamA])
  assert.equal(team?.name, "Platform One")
})

test("invalid uploads are refused synchronously", async () => {
  const garbage = await apiA("POST", "/v1/config-blobs/change-requests", { blob: { hello: "world" }, mode: "merge" })
  assert.equal(garbage.status, 400, summary(garbage))
  assert.equal(field(garbage.body, "error"), "invalid_blob")
  const unknown = await apiA("POST", "/v1/config-blobs/change-requests", { blob: { format: "openwork.config-blob", formatVersion: 1, scope: ["members.teams"], areas: { nope: { specVersion: 1, items: [] } } }, mode: "merge" })
  assert.equal(unknown.status, 400, summary(unknown))
})

test("require a second approver: two different members, the second not the creator", async () => {
  const admin = await den.newMember(owner, orgA.orgId, "Flow Admin", "admin")
  const apiAdmin = den.as(admin, orgA.orgId)
  const turnedOn = await apiA("PATCH", "/v1/config-blobs/settings", { requireSecondApprover: true })
  assert.equal(turnedOn.status, 200, summary(turnedOn))
  assert.equal(field(turnedOn.body, "settings", "requireSecondApprover"), true)

  const blob = asBlob((await apiA("GET", "/v1/config-blobs/export?areas=members.teams")).body)
  setAreaItems(blob, "members.teams", areaItems(blob, "members.teams").map((item) => (item.id === teamA ? { ...item, name: "Platform Approved" } : item)))
  const created = asSummary(await apiA("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge" }))
  assert.equal((await drive(apiA, created.id)).status, "needs_review")
  const current = await plan(apiA, created.id)

  const first = asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/approve`, { planHash: current.planHash }))
  assert.equal(first.status, "needs_review", "one approval is not enough")
  assert.equal(first.approvals.length, 1)
  const again = await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/approve`, { planHash: current.planHash })
  assert.equal(again.status, 409, summary(again))
  const early = await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/apply`, {})
  assert.equal(early.status, 409, summary(early))
  const second = await apiAdmin("POST", `/v1/config-blobs/change-requests/${created.id}/approve`, { planHash: current.planHash })
  assert.equal(second.status, 200, summary(second))
  assert.equal(asSummary(second).status, "approved")
  assert.equal(asSummary(second).approvals.length, 2)

  await apiA("POST", `/v1/config-blobs/change-requests/${created.id}/cancel`, {})
  const turnedOff = await apiA("PATCH", "/v1/config-blobs/settings", { requireSecondApprover: false })
  assert.equal(field(turnedOff.body, "settings", "requireSecondApprover"), false)
})
