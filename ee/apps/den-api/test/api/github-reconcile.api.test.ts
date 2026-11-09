/**
 * The GitHub reconcile keeps each target's schedule in connector_target_reconcile
 * and reads due targets from it in pages, so a run never loads every target's
 * config. Runs can overlap (a slow cron call and the next one): each target is
 * claimed by one of them. A target that needs a person is paused until the
 * connector is edited, and the state carries over from the target's config,
 * where earlier releases kept it.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen } from "./harness.js"

const MAINTENANCE_TOKEN = "github-reconcile-test-maintenance-token"
const den = await bootDen({ env: { DEN_MAINTENANCE_TOKEN: MAINTENANCE_TOKEN } })
after(() => den.close())

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

type OrgId = ReturnType<typeof createDenTypeId<"organization">>
type MemberId = ReturnType<typeof createDenTypeId<"member">>

async function seedConnector(name: string, options: { instanceStatus?: "active" | "disabled" } = {}) {
  const { db } = await import("../../src/db.js")
  const { ConnectorAccountTable, ConnectorInstanceTable } = await import("@openwork-ee/den-db/schema")
  const { orgId, owner } = await den.createOrg(await den.signUp(`${name} Owner`), `${name} org`)
  const organizationId = orgId as OrgId
  const ownerId = owner.memberId as MemberId
  const accountId = createDenTypeId("connectorAccount")
  await db.insert(ConnectorAccountTable).values({
    connectorType: "github", createdByOrgMembershipId: ownerId, displayName: "acme", id: accountId, organizationId, remoteId: "4242",
  })
  const instance = (instanceName: string, createdBy: MemberId) => ({
    connectorAccountId: accountId, connectorType: "github" as const, createdByOrgMembershipId: createdBy,
    id: createDenTypeId("connectorInstance"), instanceConfigJson: { installationId: 4242 }, name: instanceName, organizationId,
    status: options.instanceStatus ?? "active" as const,
  })
  return { instance, organizationId, ownerId }
}

function brokenTarget(input: { instanceId: ReturnType<typeof createDenTypeId<"connectorInstance">>; organizationId: OrgId; updatedAt?: Date; config?: Record<string, unknown> }) {
  // No branch: probing pauses it without calling GitHub.
  const id = createDenTypeId("connectorTarget")
  return {
    connectorInstanceId: input.instanceId, connectorType: "github" as const, externalTargetRef: null, id,
    organizationId: input.organizationId, remoteId: `acme/${id}`, targetConfigJson: input.config ?? { note: "kept" }, targetKind: "repository_branch" as const,
    updatedAt: input.updatedAt ?? new Date(Date.now() - 7 * DAY_MS),
  }
}

test("broken targets are probed once across overlapping runs and wait for an edit", async () => {
  const { db } = await import("../../src/db.js")
  const { ConnectorInstanceTable, ConnectorSyncEventTable, ConnectorTargetReconcileTable, ConnectorTargetTable } = await import("@openwork-ee/den-db/schema")
  const { eq, inArray } = await import("@openwork-ee/den-db/drizzle")
  const { reconcileGithubConnectorTargets } = await import("../../src/workers/github-sync.js")

  const { instance, organizationId, ownerId } = await seedConnector("Rhea Reconcile")
  // The owner made this one, but its target lost its repository and branch.
  const ownInstance = instance("acme/broken", ownerId)
  // A member who has since left made this one.
  const orphanInstance = instance("acme/orphan", createDenTypeId("member"))
  await db.insert(ConnectorInstanceTable).values([ownInstance, orphanInstance])

  const lastWeek = new Date(Date.now() - 7 * DAY_MS)
  const missingMetadata = brokenTarget({ instanceId: ownInstance.id, organizationId, updatedAt: lastWeek })
  const orphaned = {
    ...brokenTarget({ instanceId: orphanInstance.id, organizationId, updatedAt: lastWeek }),
    externalTargetRef: "main", remoteId: "acme/orphan", targetConfigJson: { branch: "main", repositoryFullName: "acme/orphan" },
  }
  // An earlier release left this one backing off in its config: the backoff carries over.
  const backingOff = brokenTarget({
    config: { githubReconcile: { error: "Server Error", failureCount: 3, lastProbedAt: new Date().toISOString(), nextProbeAt: new Date(Date.now() + HOUR_MS).toISOString(), pausedRevision: null, status: "retrying" } },
    instanceId: ownInstance.id, organizationId,
  })
  const deleted = brokenTarget({ instanceId: ownInstance.id, organizationId })
  await db.insert(ConnectorTargetTable).values([missingMetadata, orphaned, backingOff, deleted])
  await db.delete(ConnectorTargetTable).where(eq(ConnectorTargetTable.id, deleted.id))
  // A reconcile row whose target was deleted is cleaned up when it comes due.
  await db.insert(ConnectorTargetReconcileTable).values({ connectorTargetId: deleted.id, connectorType: "github", nextProbeAt: new Date(Date.now() - HOUR_MS), organizationId })

  const targetIds = [missingMetadata.id, orphaned.id, backingOff.id]
  const readState = async () => new Map((await db.select().from(ConnectorTargetReconcileTable)
    .where(inArray(ConnectorTargetReconcileTable.connectorTargetId, [...targetIds, deleted.id]))).map((row) => [row.connectorTargetId, row]))

  // Two runs at once: each target is probed by exactly one of them.
  const now = new Date()
  const runs = await Promise.all([reconcileGithubConnectorTargets(now), reconcileGithubConnectorTargets(now)])
  assert.equal(runs[0].probed + runs[1].probed, 2, "the backing-off target is not due yet")
  assert.equal(runs[0].enqueued + runs[1].enqueued, 0)
  assert.equal(runs[0].removed + runs[1].removed, 1)

  let state = await readState()
  assert.equal(state.get(missingMetadata.id)?.status, "paused")
  assert.equal(state.get(missingMetadata.id)?.nextProbeAt, null)
  assert.equal(state.get(missingMetadata.id)?.error, "GitHub connector target is missing repository, branch, or installation metadata.")
  assert.equal(state.get(orphaned.id)?.error, "Connector creator member not found.")
  assert.equal(state.get(backingOff.id)?.status, "retrying")
  assert.equal(state.get(backingOff.id)?.failureCount, 3)
  assert.equal(state.has(deleted.id), false)

  const targets = await db.select().from(ConnectorTargetTable).where(inArray(ConnectorTargetTable.id, targetIds))
  const missingRow = targets.find((target) => target.id === missingMetadata.id)
  assert.equal(missingRow?.updatedAt.getTime(), lastWeek.getTime(), "probe state is not an edit")
  assert.deepEqual(missingRow?.targetConfigJson, { note: "kept" }, "the target config is untouched")

  // A day later the paused targets stay paused; the backing-off one is probed.
  const nextDay = await reconcileGithubConnectorTargets(new Date(now.getTime() + DAY_MS))
  assert.equal(nextDay.probed, 1)
  assert.equal((await readState()).get(backingOff.id)?.status, "paused")

  // Editing the target resumes it; it is still broken, so it pauses again.
  await db.update(ConnectorTargetTable).set({ updatedAt: new Date() }).where(eq(ConnectorTargetTable.id, missingMetadata.id))
  const afterEdit = await reconcileGithubConnectorTargets(new Date(now.getTime() + 2 * DAY_MS))
  assert.equal(afterEdit.resumed, 1)
  assert.equal(afterEdit.probed, 1)
  state = await readState()
  assert.equal(state.get(missingMetadata.id)?.status, "paused")
  assert.equal(state.get(missingMetadata.id)?.failureCount, 2)

  const events = await db.select({ id: ConnectorSyncEventTable.id }).from(ConnectorSyncEventTable).where(inArray(ConnectorSyncEventTable.connectorTargetId, targetIds))
  assert.equal(events.length, 0, "no sync was queued for a target that cannot sync")
})

test("a run reads due targets in pages and stops at its page budget, leaving the rest for the next run", async () => {
  const { db } = await import("../../src/db.js")
  const { ConnectorInstanceTable, ConnectorSyncEventTable, ConnectorTargetReconcileTable, ConnectorTargetTable } = await import("@openwork-ee/den-db/schema")
  const { inArray } = await import("@openwork-ee/den-db/drizzle")
  const { GITHUB_RECONCILE_PROBE_LEASE_MS, reconcileGithubConnectorTargets } = await import("../../src/workers/github-sync.js")

  const { instance, organizationId, ownerId } = await seedConnector("Paige Pager")
  const active = instance("acme/many", ownerId)
  await db.insert(ConnectorInstanceTable).values(active)
  const backlog = Array.from({ length: 7 }, () => brokenTarget({ instanceId: active.id, organizationId }))
  // Already syncing: claimed and left until its claim passes, not probed.
  const syncing = brokenTarget({ instanceId: active.id, organizationId })
  await db.insert(ConnectorTargetTable).values([...backlog, syncing])
  await db.insert(ConnectorSyncEventTable).values({
    connectorInstanceId: active.id, connectorTargetId: syncing.id, connectorType: "github", eventType: "push",
    id: createDenTypeId("connectorSyncEvent"), organizationId, status: "running", summaryJson: { trigger: "test" },
  })

  const disabled = await seedConnector("Dee Disabled", { instanceStatus: "disabled" })
  const disabledInstance = disabled.instance("acme/disabled", disabled.ownerId)
  await db.insert(ConnectorInstanceTable).values(disabledInstance)
  const inactive = brokenTarget({ instanceId: disabledInstance.id, organizationId: disabled.organizationId })
  await db.insert(ConnectorTargetTable).values(inactive)

  const now = new Date()
  const first = await reconcileGithubConnectorTargets(now, { batchSize: 3, maxBatches: 2 })
  assert.equal(first.seeded, 9)
  assert.equal(first.batches, 2)
  assert.equal(first.claimed, 6)
  assert.equal(first.hasMore, true, "due targets are left for the next run")

  const second = await reconcileGithubConnectorTargets(now, { batchSize: 3, maxBatches: 2 })
  assert.equal(second.seeded, 0)
  assert.equal(second.claimed, 3)
  assert.equal(second.hasMore, false)
  assert.equal(first.probed + second.probed, 7)
  assert.equal(first.skippedSyncing + second.skippedSyncing, 1)

  const rows = new Map((await db.select().from(ConnectorTargetReconcileTable)
    .where(inArray(ConnectorTargetReconcileTable.connectorTargetId, [...backlog.map((row) => row.id), syncing.id, inactive.id]))).map((row) => [row.connectorTargetId, row]))
  for (const target of backlog) assert.equal(rows.get(target.id)?.status, "paused")
  assert.equal(rows.get(syncing.id)?.nextProbeAt?.getTime(), now.getTime() + GITHUB_RECONCILE_PROBE_LEASE_MS, "checked again once its claim passes")
  assert.equal(rows.get(syncing.id)?.lastProbedAt, null)
  assert.equal(rows.get(inactive.id)?.status, "ok")
  assert.equal(rows.get(inactive.id)?.lastProbedAt, null, "an inactive connector is not probed")
  assert.equal((rows.get(inactive.id)?.nextProbeAt?.getTime() ?? 0) > now.getTime() + HOUR_MS, true)

  const idle = await reconcileGithubConnectorTargets(now, { batchSize: 3, maxBatches: 2 })
  assert.deepEqual({ claimed: idle.claimed, hasMore: idle.hasMore, batches: idle.batches }, { claimed: 0, hasMore: false, batches: 1 })
})

test("the maintenance endpoint runs one reconcile for a caller with the maintenance token", async () => {
  const wrong = await den.request("not-the-maintenance-token-at-all", "POST", "/internal/github/reconcile/run")
  assert.equal(wrong.status, 401)
  const missing = await den.request(null, "POST", "/internal/github/reconcile/run")
  assert.equal(missing.status, 401)

  const run = await den.request(MAINTENANCE_TOKEN, "POST", "/internal/github/reconcile/run")
  assert.equal(run.status, 200, run.text)
  assert.equal(typeof run.body === "object" && run.body !== null && "hasMore" in run.body ? run.body.hasMore : undefined, false)
})
