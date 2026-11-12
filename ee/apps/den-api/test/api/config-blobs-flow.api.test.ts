/**
 * Config blobs end to end through HTTP: export, edit, upload, analysis
 * (worker driven in-process), decisions and secret inputs, approval, apply,
 * re-export, import into a second organization on the same instance (ids
 * taken → aliases), idempotent re-import, revert, drift → stale, the
 * per-organization apply lock, and the feature gate.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyReport, ConfigBlob, ConfigChangeRequestSummary, ConfigPlan, ConfigPlanItem, ConfigSecretInput } from "@openwork/types/den/config-blobs"
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
  const runs = asRuns(field(detail.body, "runs"))
  assert.equal(runs.length, 1, "one run per apply attempt")
  const [run] = runs
  assert.ok(run)
  assert.equal(run.status, "applied")
  assert.equal(run.attempt, 1)
  assert.equal(field(detail.body, "report", "runId"), run.runId, "report is the latest run")
  assert.deepEqual(run.items.map((item) => [item.area, item.ref, item.name, item.status]), [["connectors.mcp", mcpId, "Docs MCP", "applied"]], "only the written item is in the report")
  assert.equal(run.runsAs?.memberId, orgA.owner.memberId)
  assert.ok(run.finishedAt && run.items[0]?.startedAt)
  assert.ok(run.afterRevs?.[`connectors.mcp/${mcpId}`], "the after-state rev of the written item")
  const one = await apiA("GET", `/v1/config-blobs/change-requests/${request.id}/runs/${run.runId}`)
  assert.equal(one.status, 200, summary(one))
  assert.equal(field(one.body, "run", "runId"), run.runId)
  const [stored] = await rows("SELECT status, failure_code, report FROM config_apply_run WHERE id = ?", [run.runId])
  assert.equal(stored?.status, "applied")
  assert.equal(stored?.failure_code, null)
  assert.ok(!String(stored?.report).includes("Docs MCP"), "the stored report is encrypted")
  const snapshot = await apiA("GET", `/v1/config-blobs/change-requests/${request.id}/before-snapshot`)
  assert.equal(snapshot.status, 200, summary(snapshot))
  const before = asBlob(snapshot.body)
  assert.deepEqual(before.scope, ["connectors.mcp"], "the snapshot covers the areas written")
  assert.deepEqual(areaItems(before, "connectors.mcp").map((item) => item.id), [mcpId], "and only the items written")
  assert.equal(areaItems(before, "connectors.mcp")[0]?.spec.exposeDirectly, false)

  const actions = await jobActions(request.id)
  assert.deepEqual(actions.filter((action) => action.startsWith("config_change_request.")).sort(), ["config_change_request.apply_completed", "config_change_request.apply_started"])
  const audit = await den.auditStorageText()
  for (const secret of Object.values(SECRETS)) assert.ok(!audit.includes(secret), "no secret in the audit log")
})

test("revert: a new change request from the before-snapshot restores the old value", async () => {
  // An effect the original apply recorded as irreversible (adapters report these): the restore's plan names it.
  const latest = asRuns(field((await apiA("GET", `/v1/config-blobs/change-requests/${firstRequestId}`)).body, "runs"))[0]
  assert.ok(latest)
  await repository.createApplyRun({
    organizationId: normalizeOrg(orgA.orgId),
    changeRequestId: normalizeId(firstRequestId),
    requestedByMemberId: normalizeMember(orgA.owner.memberId),
    requestedByApiKeyId: null,
    runsAsMemberId: normalizeMember(orgA.owner.memberId),
    startedAt: new Date(),
    report: { ...latest, status: "applied", afterRevs: undefined, items: latest.items.map((item) => ({ ...item, irreversible: ["Members' sign-ins to Docs MCP were revoked"] })) },
  })
  const reverted = await apiA("POST", `/v1/config-blobs/change-requests/${firstRequestId}/revert`, {})
  assert.equal(reverted.status, 201, summary(reverted))
  const request = asSummary(reverted)
  assert.equal(request.source, "revert")
  assert.equal(request.revertsChangeRequestId, firstRequestId)
  const analyzed = await drive(apiA, request.id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  const current = await plan(apiA, request.id)
  assert.equal(current.mode, "mirror")
  assert.ok(current.issues.some((issue) => issue.level === "warning" && issue.message.startsWith("These can't be undone by restoring:") && issue.message.includes(`"Docs MCP": Members' sign-ins to Docs MCP were revoked.`)), JSON.stringify(current.issues))
  assert.ok(current.issues.some((issue) => issue.message.startsWith("Credentials are never stored in snapshots")), JSON.stringify(current.issues))
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

test("a restore touches only what the change wrote: 2 of 5 teams and its creates, never the owner or other members; a withdrawn restore can be started again", async () => {
  const orgR = await den.createOrg(owner, "Flow restore scope")
  assert.ok((await den.setFeature(orgR.orgId, "configBlobs", true)).status < 300)
  const apiR = den.as(owner, orgR.orgId)
  const member = await den.newMember(owner, orgR.orgId, "Flow Restore Member")
  const teamIds: string[] = []
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) teamIds.push(await den.createTeam(owner, orgR.orgId, name, [member.memberId]))
  const [alphaId, bravoId] = teamIds
  assert.ok(alphaId && bravoId)
  const invitee = "flow-restore-invitee@example.com"

  // The change: rename 2 of the 5 teams, add a team, invite one person.
  const blob = asBlob((await apiR("GET", "/v1/config-blobs/export?areas=members.teams,members.people")).body)
  setAreaItems(blob, "members.teams", [
    ...areaItems(blob, "members.teams").map((item) => (item.id === alphaId ? { ...item, name: "Alpha 2" } : item.id === bravoId ? { ...item, name: "Bravo 2" } : item)),
    { name: "Foxtrot", spec: TEAM_SPEC },
  ])
  setAreaItems(blob, "members.people", [...areaItems(blob, "members.people"), { name: invitee, spec: { email: invitee, role: "member", status: "invited", teams: [], managedBy: "manual" } }])
  const created = await apiR("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title: "Two renames" })
  assert.equal(created.status, 202, summary(created))
  const id = asSummary(created).id
  assert.equal((await drive(apiR, id)).status, "needs_review")
  let current = await plan(apiR, id)
  assert.deepEqual(planItems(current).filter((item) => item.op !== "unchanged").map((item) => [item.area, item.op, item.blob?.name]), [
    ["members.teams", "rename", "Alpha 2"],
    ["members.teams", "rename", "Bravo 2"],
    ["members.teams", "create", "Foxtrot"],
    ["members.people", "create", invitee],
  ], describePlan(current))

  // Sending invitation emails is named before approval as something a restore can't undo, and only then.
  const inviteEffects = (value: ConfigPlan) => planItems(value).find((item) => item.area === "members.people" && item.op === "create")?.irreversible ?? []
  assert.deepEqual(inviteEffects(current), [])
  const loud = await apiR("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { people: { sendInviteEmails: true } })
  assert.equal(loud.status, 200, summary(loud))
  const loudPlan = asPlan(field(loud.body, "plan"))
  assert.deepEqual(inviteEffects(loudPlan), [`An invitation email is sent to ${invitee}.`])
  assert.notEqual(loudPlan.planHash, current.planHash)
  const quiet = await apiR("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { people: { sendInviteEmails: false } })
  current = asPlan(field(quiet.body, "plan"))
  assert.deepEqual(inviteEffects(current), [])

  assert.equal(asSummary(await apiR("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  assert.equal((await drive(apiR, id)).status, "applied")
  const [foxtrot] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = 'Foxtrot'", [orgR.orgId])
  const foxtrotId = String(foxtrot?.id)
  const invitedId = asRuns(field((await apiR("GET", `/v1/config-blobs/change-requests/${id}`)).body, "runs"))[0]?.items.find((item) => item.area === "members.people")?.localId
  assert.ok(invitedId)

  // The restore lists the 2 renamed teams and the 2 creates (deletes, ticked), nothing else of either area.
  const startRestore = async () => {
    const reverted = await apiR("POST", `/v1/config-blobs/change-requests/${id}/revert`, {})
    assert.equal(reverted.status, 201, summary(reverted))
    const restore = asSummary(reverted)
    assert.equal((await drive(apiR, restore.id)).status, "needs_review")
    return { restoreId: restore.id, restorePlan: await plan(apiR, restore.id) }
  }
  const first = await startRestore()
  const listed = planItems(first.restorePlan).map((item) => [item.area, item.op, item.target?.id ?? null])
  assert.deepEqual(listed, [
    ["members.teams", "rename", alphaId],
    ["members.teams", "rename", bravoId],
    ["members.teams", "delete", foxtrotId],
    ["members.people", "delete", invitedId],
  ], describePlan(first.restorePlan))
  const listedIds = new Set(planItems(first.restorePlan).map((item) => item.target?.id))
  for (const untouched of [orgR.owner.memberId, member.memberId, ...teamIds.slice(2)]) assert.ok(!listedIds.has(untouched), `${untouched} is not in the restore's plan`)
  assert.equal(first.restorePlan.summary.untouched, 0)

  // Withdrawn: the change can be restored again.
  assert.equal(asSummary(await apiR("POST", `/v1/config-blobs/change-requests/${first.restoreId}/cancel`, {})).status, "cancelled")
  const original = asSummary(await apiR("GET", `/v1/config-blobs/change-requests/${id}`))
  assert.equal(original.revertedByChangeRequestId, null, "a cancelled restore no longer marks the change as restored")
  const second = await startRestore()
  assert.notEqual(second.restoreId, first.restoreId)
  assert.equal(asSummary(await apiR("GET", `/v1/config-blobs/change-requests/${id}`)).revertedByChangeRequestId, second.restoreId)
  assert.equal(asSummary(await apiR("POST", `/v1/config-blobs/change-requests/${second.restoreId}/apply`, { planHash: second.restorePlan.planHash })).status, "queued")
  assert.equal((await drive(apiR, second.restoreId)).status, "applied")
  const names = (await rows("SELECT name FROM team WHERE organization_id = ? ORDER BY name", [orgR.orgId])).map((row) => String(row.name))
  assert.deepEqual(names, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"])
  const people = asBlob((await apiR("GET", "/v1/config-blobs/export?areas=members.people")).body)
  assert.deepEqual(areaItems(people, "members.people").map((item) => String(item.spec.email).toLowerCase()).sort(), [owner.email, member.email].map((email) => email.toLowerCase()).sort())
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

// ---------------------------------------------------------------------------
// Security review fixes (M4–M11, L5, L6)

const { createDenTypeId } = await import("@openwork-ee/utils/typeid")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const { AuthSessionTable } = await import("@openwork-ee/den-db/schema")
const { db } = await import("../../src/db.js")
const { getConfigInstanceId } = await import("../../src/config-blobs/instance.js")
const { storedError, CONFIG_APPROVAL_MAX_AGE_MS } = await import("../../src/config-blobs/service.js")

/** A members.teams-only upload of `items`, analyzed to needs_review. */
async function uploadTeams(call: ReturnType<typeof den.as>, from: ConfigBlob, items: unknown[], extra: Record<string, unknown> = {}): Promise<{ id: string; plan: ConfigPlan }> {
  const blob = asBlob(from)
  setAreaItems(blob, "members.teams", items)
  const created = await call("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", ...extra })
  assert.equal(created.status, 202, summary(created))
  const id = asSummary(created).id
  const analyzed = await drive(call, id)
  assert.equal(analyzed.status, "needs_review", JSON.stringify(analyzed.errors))
  const current = await plan(call, id)
  // Items a name only proposes a match for: confirm them as new.
  const proposed = planItems(current).filter((item) => item.flags.includes("needs_mapping") && item.matchedBy === "proposed")
  if (proposed.length === 0) return { id, plan: current }
  const decided = await call("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { matches: proposed.map((item) => ({ area: item.area, ref: item.ref, targetId: "create" })) })
  assert.equal(decided.status, 200, summary(decided))
  return { id, plan: asPlan(field(decided.body, "plan")) }
}

async function teamsExport(call: ReturnType<typeof den.as>): Promise<ConfigBlob> {
  return asBlob((await call("GET", "/v1/config-blobs/export?areas=members.teams")).body)
}

const TEAM_SPEC = { grantsOrganizationAdmin: false, managedBy: "manual" }

test("approving and applying need a recent sign-in from a person (M5)", async () => {
  const admin = await den.newMember(owner, orgA.orgId, "Flow Stale Admin", "admin")
  const apiAdmin = den.as(admin, orgA.orgId)
  const { id, plan: current } = await uploadTeams(apiA, await teamsExport(apiA), [{ name: "Step Up Team", spec: TEAM_SPEC }])
  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.userId, admin.userId))
  for (const [path, body] of [["approve", { planHash: current.planHash }], ["apply", { planHash: current.planHash }]] as const) {
    const refused = await apiAdmin("POST", `/v1/config-blobs/change-requests/${id}/${path}`, body)
    assert.equal(refused.status, 403, `${path}: ${summary(refused)}`)
    assert.equal(field(refused.body, "reason"), "fresh_auth_required")
  }
  // The uploader's session is fresh: approve works; the stale admin still can't queue it.
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/approve`, { planHash: current.planHash })).status, "approved")
  const queue = await apiAdmin("POST", `/v1/config-blobs/change-requests/${id}/apply`, {})
  assert.equal(queue.status, 403, summary(queue))
  await apiA("POST", `/v1/config-blobs/change-requests/${id}/cancel`, {})
})

test("downloads (export, before-snapshot) need a recent sign-in from a person; config tokens don't", async () => {
  const admin = await den.newMember(owner, orgA.orgId, "Flow Stale Exporter", "admin")
  const apiAdmin = den.as(admin, orgA.orgId)
  const closed = await apiA("GET", "/v1/config-blobs/change-requests?state=closed")
  const list: unknown = field(closed.body, "changeRequests")
  const applied: unknown = Array.isArray(list) ? list.find((entry) => isRecord(entry) && entry.status === "applied") : undefined
  assert.ok(isRecord(applied) && typeof applied.id === "string", "an applied change request")
  const downloads = ["/v1/config-blobs/export?areas=members.teams", "/v1/config-blobs/export", `/v1/config-blobs/change-requests/${applied.id}/before-snapshot`]

  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.userId, admin.userId))
  for (const path of downloads) {
    const refused = await apiAdmin("GET", path)
    assert.equal(refused.status, 403, `${path}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), "reauth", "the refusal den-web turns into its re-sign-in prompt")
    assert.equal(field(refused.body, "reason"), "fresh_auth_required")
  }

  // Signed in again (a fresh session): the same downloads work.
  await db.update(AuthSessionTable).set({ createdAt: new Date() }).where(eq(AuthSessionTable.userId, admin.userId))
  for (const path of downloads) {
    const fresh = await apiAdmin("GET", path)
    assert.equal(fresh.status, 200, `${path}: ${summary(fresh)}`)
    assert.equal(asBlob(fresh.body).format, "openwork.config-blob")
  }

  // A config token has no session to step up.
  const created = await apiA("POST", "/v1/api-keys", { name: "Flow export CI", type: "config", scopes: ["config:export", "config:submit"] })
  assert.equal(created.status, 201, summary(created))
  const key = text(field(created.body, "key"), "token")
  for (const path of downloads) {
    const token = await den.request(null, "GET", path, { headers: { "x-api-key": key } })
    assert.equal(token.status, 200, `${path} with a config token: ${summary(token)}`)
  }
})

test("an approval older than 24 hours is not applied: back to review, approvals dropped (M5)", async () => {
  const { id, plan: current } = await uploadTeams(apiA, await teamsExport(apiA), [{ name: "Expiring Team", spec: TEAM_SPEC }])
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/approve`, { planHash: current.planHash })).status, "approved")
  const requestId = normalizeId(id)
  const old = new Date(Date.now() - CONFIG_APPROVAL_MAX_AGE_MS - 60_000).toISOString()
  const row = await repository.getChangeRequest(normalizeOrg(orgA.orgId), requestId, db.$primary)
  assert.ok(row)
  await repository.updateChangeRequest(row.organizationId, requestId, ["approved"], { approvals: row.approvals.map((approval) => ({ ...approval, at: old })) })

  // Explicit apply: refused at once.
  const refused = await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, {})
  assert.equal(refused.status, 409, summary(refused))
  assert.equal(field(refused.body, "error"), "approval_expired")
  let after = asSummary(await apiA("GET", `/v1/config-blobs/change-requests/${id}`))
  assert.equal(after.status, "needs_review")
  assert.deepEqual(after.approvals, [])

  // Already queued (auto-apply, or queued earlier): the worker sends it back instead of applying.
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  const queued = await repository.getChangeRequest(normalizeOrg(orgA.orgId), requestId, db.$primary)
  assert.ok(queued)
  await repository.updateChangeRequest(queued.organizationId, requestId, ["queued"], { approvals: queued.approvals.map((approval) => ({ ...approval, at: old })) })
  const claim = await repository.claimNextApply()
  assert.equal(claim?.id, id)
  assert.ok(claim)
  assert.equal(await applyClaimedChangeRequest(claim), "needs_review")
  after = asSummary(await apiA("GET", `/v1/config-blobs/change-requests/${id}`))
  assert.equal(after.status, "needs_review")
  assert.deepEqual(after.approvals, [])
  assert.match(after.errors.join(" "), /Approval expired/)
  const [team] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = ?", [orgA.orgId, "Expiring Team"])
  assert.equal(team, undefined, "nothing was applied")
  await apiA("POST", `/v1/config-blobs/change-requests/${id}/cancel`, {})
})

test("invalid requests drop their secret inputs; stored errors are bounded and redacted (M4, errors)", async () => {
  const blob = await teamsExport(apiA)
  const duplicate = { id: teamA, name: "Twin", spec: TEAM_SPEC }
  setAreaItems(blob, "members.teams", [duplicate, { ...duplicate, name: "Twin again" }])
  const row = await repository.createChangeRequest({
    organizationId: normalizeOrg(orgA.orgId), status: "uploaded", sourceKind: "ui", mode: "merge", blob, areas: ["members.teams"],
    createdByMemberId: normalizeMember(orgA.owner.memberId), secretInputs: [{ path: "members.teams/x/y", decision: "value", value: "sk-flow-invalid-SECRET-1" }],
  })
  const settled = await drive(apiA, row.id)
  assert.equal(settled.status, "invalid", JSON.stringify(settled))
  const [stored] = await rows("SELECT secret_inputs, approvals FROM config_change_request WHERE id = ?", [row.id])
  assert.equal(stored?.secret_inputs, null)

  assert.equal(storedError("upstream said: Bearer abcdef0123456789"), "[withheld]")
  assert.equal(storedError(`bad ${"x".repeat(2000)}`).length, 500)
  assert.equal(storedError("line one\nline two"), "line one line two")
})

test("a blob from this instance never reuses ids: a deleted item comes back under a new id with an alias and its provenance (M6, M8)", async () => {
  const ephemeral = await den.createTeam(owner, orgA.orgId, "Ephemeral", [])
  const exportedWithTeam = await teamsExport(apiA)
  const item = areaItems(exportedWithTeam, "members.teams").find((entry) => entry.id === ephemeral)
  assert.ok(item)
  const removed = await apiA("DELETE", `/v1/teams/${ephemeral}`)
  assert.ok(removed.status < 300, summary(removed))

  const first = await uploadTeams(apiA, exportedWithTeam, [item])
  assert.equal(first.plan.summary.create, 1, describePlan(first.plan))
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${first.id}/apply`, { planHash: first.plan.planHash })).status, "queued")
  assert.equal((await drive(apiA, first.id)).status, "applied")
  const [team] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = ?", [orgA.orgId, "Ephemeral"])
  assert.ok(team && team.id !== ephemeral, "the old id of a deleted item is not reused for a blob from this instance")
  const aliases = await rows("SELECT local_id, created_by_change_request_id FROM config_blob_alias WHERE organization_id = ? AND area = 'members.teams' AND source_id = ?", [orgA.orgId, ephemeral])
  assert.deepEqual(aliases.map((alias) => [alias.local_id, alias.created_by_change_request_id]), [[team.id, first.id]])

  const again = await uploadTeams(apiA, exportedWithTeam, [item])
  const matched = planItems(again.plan).find((entry) => entry.ref === ephemeral)
  assert.equal(matched?.matchedBy, "alias", describePlan(again.plan))
  assert.ok(matched?.reasons?.includes(`matched via an earlier import (${first.id})`), JSON.stringify(matched?.reasons))
  await apiA("POST", `/v1/config-blobs/change-requests/${again.id}/cancel`, {})
})

test("ids from another instance are reused only when free and never in this organization's audit history (M6)", async () => {
  const ghost = await den.createTeam(owner, orgA.orgId, "Ghost", [])
  const removed = await apiA("DELETE", `/v1/teams/${ghost}`)
  assert.ok(removed.status < 300, summary(removed))
  const audited = await rows("SELECT 1 AS hit FROM audit_event_resource WHERE organization_id = ? AND resource_id = ?", [orgA.orgId, ghost])
  assert.ok(audited.length > 0, "the deleted team is in the audit history")

  const blob = await teamsExport(apiA)
  assert.ok(blob.source)
  blob.source = { ...blob.source, instanceId: "dni_flow_elsewhere" }
  delete blob.baseHash
  const fresh = createDenTypeId("team")
  const { id, plan: current } = await uploadTeams(apiA, blob, [{ id: ghost, name: "Ghost Imported", spec: TEAM_SPEC }, { id: fresh, name: "Fresh Imported", spec: TEAM_SPEC }])
  assert.equal(current.summary.create, 2, describePlan(current))
  assert.equal(current.summary.blocking, 0, describePlan(current))
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  assert.equal((await drive(apiA, id)).status, "applied")
  const [ghostTeam] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = ?", [orgA.orgId, "Ghost Imported"])
  const [freshTeam] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = ?", [orgA.orgId, "Fresh Imported"])
  assert.ok(ghostTeam && ghostTeam.id !== ghost, "an id from this org's audit history is not reused")
  assert.equal(freshTeam?.id, fresh, "a free id from another instance is reused")
})

test("a role from another instance keeps its id although the roles area's tables hold ids of other prefixes", async () => {
  // Regression: the free-id check compared the role's `pms_` id with typed `psp_` columns, whose encoder threw.
  const exported = asBlob((await apiA("GET", "/v1/config-blobs/export?areas=members.roles")).body)
  assert.ok(exported.source)
  exported.source = { ...exported.source, instanceId: "dni_flow_role_elsewhere" }
  delete exported.baseHash
  const roleId = createDenTypeId("permissionSet")
  setAreaItems(exported, "members.roles", [{ id: roleId, name: "Imported Readers", spec: { builtIn: null, allow: ["teams.view"], teams: [] } }])
  const created = await apiA("POST", "/v1/config-blobs/change-requests", { blob: exported, mode: "merge" })
  assert.equal(created.status, 202, summary(created))
  const id = asSummary(created).id
  assert.equal((await drive(apiA, id)).status, "needs_review")
  const current = await plan(apiA, id)
  assert.equal(current.summary.blocking, 0, describePlan(current))
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  const applied = await drive(apiA, id)
  assert.equal(applied.status, "applied", JSON.stringify(applied.errors))
  const [role] = await rows("SELECT id FROM permission_set WHERE organization_id = ? AND name = ?", [orgA.orgId, "Imported Readers"])
  assert.equal(role?.id, roleId, "the free role id from another instance is reused")
})

test("a hand-made blob claiming to come from this instance can't pin aliases through decisions (M8)", async () => {
  const blob = await teamsExport(apiA)
  blob.baseHash = `sha256:${"0".repeat(64)}`
  assert.equal(blob.source?.instanceId, await getConfigInstanceId())
  const sourceId = createDenTypeId("team")
  const target = await den.createTeam(owner, orgA.orgId, "Decision Target", [])
  const request = (await uploadTeams(apiA, blob, [{ id: sourceId, name: "Decided Elsewhere", spec: TEAM_SPEC }])).id
  const decided = await apiA("PUT", `/v1/config-blobs/change-requests/${request}/decisions`, { matches: [{ area: "members.teams", ref: sourceId, targetId: target }] })
  assert.equal(decided.status, 200, summary(decided))
  const decidedPlan = asPlan(field(decided.body, "plan"))
  assert.equal(planItems(decidedPlan).find((item) => item.ref === sourceId)?.matchedBy, "decision", describePlan(decidedPlan))
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${request}/apply`, { planHash: decidedPlan.planHash })).status, "queued")
  assert.equal((await drive(apiA, request)).status, "applied")
  const aliases = await rows("SELECT id FROM config_blob_alias WHERE organization_id = ? AND source_id = ?", [orgA.orgId, sourceId])
  assert.deepEqual(aliases, [], "no alias from an unverified same-instance blob")
})

test("deleting an item through an apply removes the aliases pointing at it (M8)", async () => {
  const [platformB] = await rows("SELECT id FROM team WHERE organization_id = ? AND name = ?", [orgB.orgId, "Platform"])
  assert.ok(platformB)
  const before = await rows("SELECT id FROM config_blob_alias WHERE organization_id = ? AND local_id = ?", [orgB.orgId, String(platformB.id)])
  assert.ok(before.length > 0, "the clone's Platform team has an alias")
  const blob = await teamsExport(apiB)
  setAreaItems(blob, "members.teams", areaItems(blob, "members.teams").filter((item) => item.id !== platformB.id))
  const created = await apiB("POST", "/v1/config-blobs/change-requests", { blob, mode: "mirror" })
  assert.equal(created.status, 202, summary(created))
  const id = asSummary(created).id
  assert.equal((await drive(apiB, id)).status, "needs_review")
  const decided = await apiB("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { deletes: [{ area: "members.teams", targetId: platformB.id }] })
  assert.equal(decided.status, 200, summary(decided))
  const current = asPlan(field(decided.body, "plan"))
  assert.equal(current.summary.delete, 1, describePlan(current))
  assert.equal(asSummary(await apiB("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  assert.equal((await drive(apiB, id)).status, "applied")
  const after = await rows("SELECT id FROM config_blob_alias WHERE organization_id = ? AND local_id = ?", [orgB.orgId, String(platformB.id)])
  assert.deepEqual(after, [])
})

test("an apply that lost its lease stops before its next write (M10)", async () => {
  const { id, plan: current } = await uploadTeams(apiA, await teamsExport(apiA), [{ name: "Lease One", spec: TEAM_SPEC }, { name: "Lease Two", spec: TEAM_SPEC }])
  assert.equal(current.summary.blocking, 0, describePlan(current))
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  const claim = await repository.claimNextApply()
  assert.equal(claim?.id, id)
  assert.ok(claim)
  // Another worker took the request over after a snapshot was written.
  claim.beforeSnapshot = { taken: true }
  await rows("UPDATE config_change_request SET lease_owner = 'another-worker' WHERE id = ?", [id])
  assert.equal(await applyClaimedChangeRequest(claim), "failed")
  const written = await rows("SELECT id FROM team WHERE organization_id = ? AND name IN ('Lease One', 'Lease Two')", [orgA.orgId])
  assert.deepEqual(written, [], "nothing was written once the lease was gone")
  await rows("UPDATE config_change_request SET status = 'failed', lease_owner = NULL, lease_until = NULL WHERE id = ?", [id])
})

test("the apply's audit names who queued it and who it ran as (L6)", async () => {
  const admin = await den.newMember(owner, orgA.orgId, "Flow Approver", "admin")
  const { id, plan: current } = await uploadTeams(apiA, await teamsExport(apiA), [{ name: "Audited Team", spec: TEAM_SPEC }])
  assert.equal(asSummary(await den.as(admin, orgA.orgId)("POST", `/v1/config-blobs/change-requests/${id}/approve`, { planHash: current.planHash })).status, "approved")
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, {})).status, "queued")
  assert.equal((await drive(apiA, id)).status, "applied")
  const [operation] = await rows("SELECT principal_key, initiating_actor FROM audit_operation WHERE kind = 'config_blobs.apply' AND scope = ?", [id])
  assert.ok(operation, "the apply's job operation")
  const initiating: unknown = typeof operation.initiating_actor === "string" ? JSON.parse(operation.initiating_actor) : operation.initiating_actor
  assert.equal(field(initiating, "id"), owner.userId, "initiated by the member who queued it")
  assert.ok(String(operation.principal_key).includes(admin.userId), "runs as the last approver")
})

function asRuns(value: unknown): ConfigApplyReport[] {
  assert.ok(Array.isArray(value), "runs")
  return JSON.parse(JSON.stringify(value))
}

test("a failing item: the run stops there, earlier items stay written, later ones are not reached, and the report says where", async () => {
  const blob = asBlob((await apiA("GET", "/v1/config-blobs/export?areas=members.teams,connectors.mcp")).body)
  const docs = areaItems(blob, "connectors.mcp").find((item) => item.id === mcpId)
  assert.ok(docs)
  const connection = (name: string, url: string) => {
    const spec: Record<string, unknown> = JSON.parse(JSON.stringify(docs.spec).replaceAll(`connectors.mcp/${mcpId}/`, `connectors.mcp/#${name}/`))
    return { name, key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), spec: { ...spec, url } }
  }
  setAreaItems(blob, "members.teams", [...areaItems(blob, "members.teams"), { name: "Partial Team", spec: TEAM_SPEC }])
  setAreaItems(blob, "connectors.mcp", [
    ...areaItems(blob, "connectors.mcp"),
    connection("Broken MCP", "http://127.0.0.1:9/mcp"),
    connection("Never MCP", `${mcpServer.url}/mcp`),
  ])
  const created = await apiA("POST", "/v1/config-blobs/change-requests", { blob, mode: "merge", title: "Partial" })
  assert.equal(created.status, 202, summary(created))
  const id = asSummary(created).id
  assert.equal((await drive(apiA, id)).status, "needs_review")
  let current = await plan(apiA, id)
  const proposed = planItems(current).filter((item) => item.flags.includes("needs_mapping"))
  if (proposed.length > 0) {
    const decided = await apiA("PUT", `/v1/config-blobs/change-requests/${id}/decisions`, { matches: proposed.map((item) => ({ area: item.area, ref: item.ref, targetId: "create" })) })
    current = asPlan(field(decided.body, "plan"))
  }
  const inputs: ConfigSecretInput[] = planItems(current).flatMap((item) => (item.op === "create" ? item.secrets ?? [] : []))
    .map((secret): ConfigSecretInput => (secret.sourceHadValue ? { path: secret.path, decision: "value", value: SECRETS.mcp } : { path: secret.path, decision: "unset" }))
  if (inputs.length > 0) current = asPlan(field((await apiA("PUT", `/v1/config-blobs/change-requests/${id}/inputs`, { inputs })).body, "plan"))
  assert.equal(current.summary.blocking, 0, describePlan(current))
  assert.deepEqual(planItems(current).filter((item) => item.op === "create").map((item) => item.blob?.name), ["Partial Team", "Broken MCP", "Never MCP"], describePlan(current))
  const [stored] = await rows("SELECT execution IS NOT NULL AS has_execution FROM config_change_request WHERE id = ?", [id])
  assert.equal(Number(stored?.has_execution), 1, "the execution plan is kept with the plan: apply re-reads only what it writes")

  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  const settled = await drive(apiA, id)
  assert.equal(settled.status, "failed")
  assert.ok(settled.errors.some((error) => error.includes("Broken MCP")), JSON.stringify(settled.errors))

  const detail = await apiA("GET", `/v1/config-blobs/change-requests/${id}`)
  const runs = asRuns(field(detail.body, "runs"))
  assert.equal(runs.length, 1)
  const [run] = runs
  assert.ok(run)
  assert.equal(run.status, "failed")
  assert.deepEqual(run.items.map((item) => [item.name, item.status]), [["Partial Team", "applied"], ["Broken MCP", "failed"], ["Never MCP", "not_reached"]])
  assert.deepEqual(run.counts, { applied: 1, noop: 0, failed: 1, not_reached: 1, skipped: 0 })
  assert.equal(run.failure?.name, "Broken MCP")
  assert.equal(run.failure?.area, "connectors.mcp")
  assert.ok(run.failure?.failure.message, "the failure has a message")
  // The item's name is said once: the route's message already names it, so no `Create "Broken MCP": ` in front.
  const occurrences = (value: string) => value.split("Broken MCP").length - 1
  assert.equal(occurrences(run.failure.failure.message), 1, run.failure.failure.message)
  assert.ok(!run.failure.failure.message.startsWith(`Create "Broken MCP"`), run.failure.failure.message)
  const requestError = settled.errors.find((error) => error.includes("Broken MCP"))
  assert.equal(occurrences(requestError ?? ""), 1, requestError)
  assert.equal(run.items[2]?.startedAt, null)
  const [row] = await rows("SELECT status, failure_area, failure_ref, failure_code FROM config_apply_run WHERE id = ?", [run.runId])
  assert.equal(row?.status, "failed")
  assert.equal(row?.failure_area, "connectors.mcp")
  assert.equal(row?.failure_code, run.failure?.failure.code)
  const teams = await rows("SELECT id FROM team WHERE organization_id = ? AND name = 'Partial Team'", [orgA.orgId])
  assert.equal(teams.length, 1, "the item before the failure stays written (no transaction)")
  const never = await rows("SELECT id FROM external_mcp_connection WHERE organization_id = ? AND name IN ('Broken MCP', 'Never MCP')", [orgA.orgId])
  assert.deepEqual(never, [])
  const missing = await apiA("GET", `/v1/config-blobs/change-requests/${id}/runs/car_01jzzzzzzzzzzzzzzzzzzzzzzz`)
  assert.equal(missing.status, 404, summary(missing))

  // Restore previous config: deletes what the failed run created.
  const reverted = await apiA("POST", `/v1/config-blobs/change-requests/${id}/revert`, {})
  assert.equal(reverted.status, 201, summary(reverted))
  const restore = asSummary(reverted)
  assert.equal(restore.title, "Restore previous config: Partial")
  assert.equal((await drive(apiA, restore.id)).status, "needs_review")
  const restorePlan = await plan(apiA, restore.id)
  assert.deepEqual(planItems(restorePlan).filter((item) => item.op === "delete").map((item) => item.target?.name), ["Partial Team"], describePlan(restorePlan))
  await apiA("POST", `/v1/config-blobs/change-requests/${restore.id}/cancel`, {})
})

test("an interrupted apply: the next claim marks the run interrupted, the item in flight failed", async () => {
  const { id, plan: current } = await uploadTeams(apiA, await teamsExport(apiA), [{ name: "Crash One", spec: TEAM_SPEC }])
  assert.equal(asSummary(await apiA("POST", `/v1/config-blobs/change-requests/${id}/apply`, { planHash: current.planHash })).status, "queued")
  const claim = await repository.claimNextApply()
  assert.equal(claim?.id, id)
  const startedAt = new Date()
  const run = await repository.createApplyRun({
    organizationId: normalizeOrg(orgA.orgId),
    changeRequestId: normalizeId(id),
    requestedByMemberId: normalizeMember(orgA.owner.memberId),
    requestedByApiKeyId: null,
    runsAsMemberId: normalizeMember(orgA.owner.memberId),
    startedAt,
    report: {
      runId: "", attempt: 0, status: "running", startedAt: startedAt.toISOString(), finishedAt: null, requestedBy: null, runsAs: null,
      counts: { applied: 0, noop: 0, failed: 0, not_reached: 0, skipped: 0 }, failure: null, warnings: [],
      items: [{ area: "members.teams", ref: "#0", name: "Crash One", op: "create", localId: null, status: "not_reached", steps: [], warnings: [], irreversible: [], startedAt: startedAt.toISOString(), durationMs: null }],
    },
  })
  // The worker died: its lease runs out and the next claim picks the request up.
  await rows("UPDATE config_change_request SET lease_until = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ?", [id])
  assert.equal(await repository.claimNextApply(), null)
  const detail = await apiA("GET", `/v1/config-blobs/change-requests/${id}`)
  assert.equal(asSummary(detail).status, "failed")
  const [interrupted] = asRuns(field(detail.body, "runs"))
  assert.equal(interrupted?.runId, run.id)
  assert.equal(interrupted?.status, "interrupted")
  assert.equal(interrupted?.items[0]?.status, "failed")
  assert.equal(interrupted?.items[0]?.failure?.code, "interrupted")
  assert.equal(interrupted?.failure?.name, "Crash One")
})

function normalizeId(id: string) {
  return normalizeTypeId("configChangeRequest", id)
}
function normalizeOrg(id: string) {
  return normalizeTypeId("organization", id)
}
function normalizeMember(id: string) {
  return normalizeTypeId("member", id)
}
const { normalizeDenTypeId: normalizeTypeId } = await import("@openwork-ee/utils/typeid")
