import assert from "node:assert/strict"
import { after, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { CreateChangeRequestInput } from "../../src/config-blobs/repository.js"
import { bootDen, isRecord } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })
const repo = await import("../../src/config-blobs/repository.js")
const { getConfigInstanceId } = await import("../../src/config-blobs/instance.js")
const { client } = await import("../../src/db.js")

async function rawRows(sql: string, params: string[]): Promise<Record<string, unknown>[]> {
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [rows] = await client.query(sql, params)
  const entries: unknown[] = Array.isArray(rows) ? rows : []
  return entries.filter(isRecord)
}

async function newOrg(name: string) {
  const { orgId, owner } = await den.createOrg(await den.signUp(`${name} Owner`), name)
  return { orgId: normalizeDenTypeId("organization", orgId), memberId: normalizeDenTypeId("member", owner.memberId), ownerName: owner.name }
}

function request(organizationId: DenTypeId<"organization">, extra: Partial<CreateChangeRequestInput> = {}): CreateChangeRequestInput {
  return {
    organizationId,
    sourceKind: "ui",
    mode: "merge",
    blob: { format: "openwork.config-blob", secretish: "skill body" },
    areas: ["members.teams"],
    ...extra,
  }
}

test("change requests: create, guarded update, list, summaries, encryption at rest", async () => {
  const org = await newOrg("Config Repo")
  const created = await repo.createChangeRequest(request(org.orgId, { title: "First", createdByMemberId: org.memberId }))
  assert.match(created.id, /^ccr_/)
  assert.equal(created.status, "uploaded")
  assert.deepEqual(created.approvals, [])
  assert.deepEqual(created.errors, [])

  const plan = {
    planHash: "sha256:x", mode: "merge" as const, areas: [], issues: [],
    summary: { create: 1, update: 0, rename: 0, unchanged: 0, delete: 0, untouched: 0, skip: 0, blocking: 0 },
  }
  const planned = await repo.updateChangeRequest(org.orgId, created.id, ["uploaded"], {
    status: "needs_review",
    plan,
    planHash: "sha256:x",
    secretInputs: [{ path: "a", decision: "value", value: "super-secret-value" }],
    approvals: [{ memberId: org.memberId, at: new Date(0).toISOString() }],
  })
  assert.equal(planned?.status, "needs_review")
  assert.deepEqual(planned?.secretInputs, [{ path: "a", decision: "value", value: "super-secret-value" }])
  // The guard refuses a transition from a status the row is no longer in.
  assert.equal(await repo.updateChangeRequest(org.orgId, created.id, ["uploaded"], { status: "cancelled" }), null)
  // Another org cannot reach the row.
  const other = await newOrg("Config Other")
  assert.equal(await repo.getChangeRequest(other.orgId, created.id), null)

  const [raw] = await rawRows("SELECT `blob`, plan, secret_inputs FROM config_change_request WHERE id = ?", [created.id])
  for (const column of ["blob", "plan", "secret_inputs"]) {
    assert.match(String(raw?.[column]), /^enc:v1:/, column)
  }
  assert.doesNotMatch(JSON.stringify(raw), /super-secret-value|skill body/)

  const open = await repo.listChangeRequests(org.orgId, { state: "open" })
  assert.deepEqual(open.map((row) => row.id), [created.id])
  assert.deepEqual(await repo.listChangeRequests(org.orgId, { state: "closed" }), [])
  const names = await repo.loadMemberNames(org.orgId, repo.summaryMemberIds(open))
  const summary = repo.toChangeRequestSummary(open[0]!, names)
  assert.equal(summary.title, "First")
  assert.equal(summary.createdBy.name, org.ownerName)
  assert.equal(summary.approvals[0]?.name, org.ownerName)
  assert.equal(summary.summary?.create, 1)
  assert.equal(summary.source, "ui")

  const second = await repo.createChangeRequest(request(org.orgId))
  await repo.updateChangeRequest(org.orgId, second.id, ["uploaded"], { status: "approved", approvedPlanHash: "sha256:y", approvals: [{ memberId: org.memberId, at: new Date().toISOString() }] })
  const staled = await repo.markOtherOpenRequestsStale(org.orgId, created.id)
  assert.deepEqual(staled, [second.id])
  const afterStale = await repo.getChangeRequest(org.orgId, second.id)
  assert.equal(afterStale?.status, "stale")
  assert.equal(afterStale?.approvedPlanHash, null)
  assert.deepEqual(afterStale?.approvals, [])
  assert.equal((await repo.getChangeRequest(org.orgId, created.id))?.status, "needs_review")
})

test("analysis claims never hand one request to two workers", async () => {
  // Drain anything earlier tests left claimable.
  while (await repo.claimNextAnalysis()) { /* drain */ }
  const org = await newOrg("Config Claims")
  const a = await repo.createChangeRequest(request(org.orgId))
  const b = await repo.createChangeRequest(request(org.orgId))
  const claims = await Promise.all([repo.claimNextAnalysis(), repo.claimNextAnalysis(), repo.claimNextAnalysis()])
  const ids = claims.flatMap((claim) => (claim ? [claim.id] : []))
  assert.ok(ids.length >= 1)
  assert.equal(new Set(ids).size, ids.length, "a request was claimed twice")
  for (const claim of claims) if (claim) assert.equal(claim.status, "analyzing")
  // A claimed request stays claimed; the rest come out one by one.
  for (let rest = await repo.claimNextAnalysis(); rest; rest = await repo.claimNextAnalysis()) ids.push(rest.id)
  assert.deepEqual([...ids].sort(), [a.id, b.id].sort())

  const claim = claims.find((entry) => entry !== null)!
  assert.equal(await repo.releaseClaim({ id: claim.id, leaseOwner: "someone-else" }, { status: "needs_review" }), false)
  assert.equal(await repo.releaseClaim(claim, { status: "needs_review" }), true)
  const released = await repo.getChangeRequest(org.orgId, claim.id)
  assert.equal(released?.status, "needs_review")
  assert.equal(released?.leaseOwner, null)
  assert.equal(released?.attempts, 1)
})

test("apply claims hold one apply per org at a time", async () => {
  while (await repo.claimNextApply()) { /* drain */ }
  const orgA = await newOrg("Config Apply A")
  const orgB = await newOrg("Config Apply B")
  const a1 = await repo.createChangeRequest(request(orgA.orgId, { status: "queued" }))
  const a2 = await repo.createChangeRequest(request(orgA.orgId, { status: "queued" }))
  const b1 = await repo.createChangeRequest(request(orgB.orgId, { status: "queued" }))

  const claims = await Promise.all([repo.claimNextApply(), repo.claimNextApply(), repo.claimNextApply()])
  const claimed = claims.flatMap((claim) => (claim ? [claim] : []))
  const byOrg = new Map<string, number>()
  for (const claim of claimed) byOrg.set(claim.organizationId, (byOrg.get(claim.organizationId) ?? 0) + 1)
  assert.ok((byOrg.get(orgA.orgId) ?? 0) <= 1, "two applies in one org")
  // Sequentially, every org with work gets exactly one apply.
  for (let more = await repo.claimNextApply(); more; more = await repo.claimNextApply()) claimed.push(more)
  assert.equal(claimed.filter((claim) => claim.organizationId === orgA.orgId).length, 1)
  assert.equal(claimed.filter((claim) => claim.organizationId === orgB.orgId).length, 1)

  // When org A's apply finishes, its next request can apply.
  const appliedA = claimed.find((claim) => claim.organizationId === orgA.orgId)!
  assert.ok([a1.id, a2.id].includes(appliedA.id))
  assert.equal(appliedA.id, a1.id, "oldest first")
  assert.equal(await repo.releaseClaim(appliedA, { status: "applied", appliedAt: new Date() }), true)
  const next = await repo.claimNextApply()
  assert.equal(next?.id, a2.id)

  // An expired apply lease no longer holds the org.
  const orgC = await newOrg("Config Apply C")
  const c1 = await repo.createChangeRequest(request(orgC.orgId, { status: "queued" }))
  const c2 = await repo.createChangeRequest(request(orgC.orgId, { status: "queued" }))
  const crashed = await repo.claimNextApply({ leaseMs: 1 })
  assert.equal(crashed?.id, c1.id)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const recovered = await repo.claimNextApply()
  assert.equal(recovered?.id, c1.id, "the crashed apply is retried first")
  assert.equal(recovered?.attempts, 2)
  assert.equal(await repo.claimNextApply(), null, `${c2.id} waits for ${c1.id}`)
  void b1
})

test("aliases map source items to local ids per source instance", async () => {
  const org = await newOrg("Config Aliases")
  await repo.insertAliases(org.orgId, [
    { area: "members.teams", sourceInstanceId: "dni_a", sourceId: "tem_1", localId: "tem_local1", createdByChangeRequestId: null },
    { area: "members.roles", sourceInstanceId: "dni_a", sourceId: "pms_1", localId: "pms_local1", createdByChangeRequestId: null },
    { area: "members.teams", sourceInstanceId: "dni_b", sourceId: "tem_1", localId: "tem_other", createdByChangeRequestId: null },
  ])
  await repo.insertAliases(org.orgId, [
    { area: "members.teams", sourceInstanceId: "dni_a", sourceId: "tem_1", localId: "tem_local2", createdByChangeRequestId: null },
  ])
  const aliases = await repo.listAliases(org.orgId, "dni_a")
  assert.deepEqual(Object.fromEntries(aliases), { "members.teams:tem_1": "tem_local2", "members.roles:pms_1": "pms_local1" })
  assert.equal((await repo.listAliases(org.orgId, "dni_b")).get(repo.aliasKey("members.teams", "tem_1")), "tem_other")
})

test("exports are kept per base hash, encrypted, and pruned to the newest ones", async () => {
  const org = await newOrg("Config Exports")
  const first = await repo.recordExport({ organizationId: org.orgId, baseHash: "sha256:first", areas: ["members.teams"], blob: { marker: "export-body" } })
  const found = await repo.findExportByBaseHash(org.orgId, "sha256:first")
  assert.equal(found?.id, first)
  assert.deepEqual(found?.blob, { marker: "export-body" })
  const [raw] = await rawRows("SELECT `blob` FROM config_blob_export WHERE id = ?", [first])
  assert.match(String(raw?.blob), /^enc:v1:/)

  for (let index = 0; index < repo.CONFIG_BLOB_EXPORTS_KEPT; index += 1) {
    await repo.recordExport({ organizationId: org.orgId, baseHash: `sha256:n${index}`, areas: ["members.teams"], blob: {} })
  }
  assert.equal(await repo.findExportByBaseHash(org.orgId, "sha256:first"), null)
  const [count] = await rawRows("SELECT COUNT(*) AS total FROM config_blob_export WHERE organization_id = ?", [org.orgId])
  assert.equal(Number(count?.total), repo.CONFIG_BLOB_EXPORTS_KEPT)
})

test("the instance id is stable", async () => {
  const id = await getConfigInstanceId()
  assert.match(id, /^dni_/)
  assert.equal(await getConfigInstanceId(), id)
  const rows = await rawRows("SELECT instance_id FROM den_instance", [])
  assert.deepEqual(rows.map((row) => row.instance_id), [id])
})
