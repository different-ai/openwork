/**
 * The GitHub reconcile loop keeps its probe state on the connector target, so
 * a replica that boots after a deploy reads it instead of probing every broken
 * target again. A target that needs a person is paused until the connector is
 * edited, and the state writes never move the target's updated_at.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const DAY_MS = 24 * 60 * 60_000

test("broken targets are probed once across replicas and wait for an edit", async () => {
  const { db } = await import("../../src/db.js")
  const { ConnectorAccountTable, ConnectorInstanceTable, ConnectorSyncEventTable, ConnectorTargetTable } = await import("@openwork-ee/den-db/schema")
  const { eq, inArray } = await import("@openwork-ee/den-db/drizzle")
  const { reconcileGithubConnectorTargets } = await import("../../src/workers/github-sync.js")
  const { readGithubReconcileState } = await import("../../src/workers/github-reconcile-state.js")

  const { orgId, owner } = await den.createOrg(await den.signUp("Rhea Reconcile"), "GitHub reconcile org")
  const organizationId = orgId as ReturnType<typeof createDenTypeId<"organization">>
  const ownerId = owner.memberId as ReturnType<typeof createDenTypeId<"member">>
  const accountId = createDenTypeId("connectorAccount")
  await db.insert(ConnectorAccountTable).values({
    connectorType: "github", createdByOrgMembershipId: ownerId, displayName: "acme", id: accountId, organizationId, remoteId: "4242",
  })
  const instance = (name: string, createdBy: typeof ownerId) => ({
    connectorAccountId: accountId, connectorType: "github" as const, createdByOrgMembershipId: createdBy,
    id: createDenTypeId("connectorInstance"), instanceConfigJson: { installationId: 4242 }, name, organizationId,
  })
  // The owner made this one, but its target lost its repository and branch.
  const ownInstance = instance("acme/broken", ownerId)
  // A member who has since left made this one.
  const orphanInstance = instance("acme/orphan", createDenTypeId("member"))
  await db.insert(ConnectorInstanceTable).values([ownInstance, orphanInstance])

  const lastWeek = new Date(Date.now() - 7 * DAY_MS)
  const missingMetadata = {
    connectorInstanceId: ownInstance.id, connectorType: "github" as const, externalTargetRef: null, id: createDenTypeId("connectorTarget"),
    organizationId, remoteId: " ", targetConfigJson: { note: "kept" }, targetKind: "repository_branch" as const, updatedAt: lastWeek,
  }
  const orphaned = {
    connectorInstanceId: orphanInstance.id, connectorType: "github" as const, externalTargetRef: "main", id: createDenTypeId("connectorTarget"),
    organizationId, remoteId: "acme/orphan", targetConfigJson: { branch: "main", repositoryFullName: "acme/orphan" }, targetKind: "repository_branch" as const, updatedAt: lastWeek,
  }
  await db.insert(ConnectorTargetTable).values([missingMetadata, orphaned])
  const targetIds = [missingMetadata.id, orphaned.id]
  const readTargets = async () => new Map((await db.select().from(ConnectorTargetTable).where(inArray(ConnectorTargetTable.id, targetIds))).map((row) => [row.id, row]))

  // Two replicas run at once: each target is probed by exactly one of them.
  const now = new Date()
  const runs = await Promise.all([reconcileGithubConnectorTargets(now), reconcileGithubConnectorTargets(now)])
  assert.equal(runs[0].probed + runs[1].probed, 2)
  assert.equal(runs[0].enqueued + runs[1].enqueued, 0)

  let targets = await readTargets()
  const paused = readGithubReconcileState(targets.get(missingMetadata.id)?.targetConfigJson)
  assert.equal(paused?.status, "paused")
  assert.equal(paused?.error, "GitHub connector target is missing repository, branch, or installation metadata.")
  assert.equal(targets.get(missingMetadata.id)?.targetConfigJson.note, "kept", "the rest of the target config is untouched")
  assert.equal(readGithubReconcileState(targets.get(orphaned.id)?.targetConfigJson)?.error, "Connector creator member not found.")
  for (const id of targetIds) assert.equal(targets.get(id)?.updatedAt.getTime(), lastWeek.getTime(), "probe state is not an edit")

  // A replica that boots a day later reads the pause instead of probing again.
  assert.deepEqual(await reconcileGithubConnectorTargets(new Date(now.getTime() + DAY_MS)), { checked: 0, enqueued: 0, probed: 0 })

  // Editing the target resumes it; it is still broken, so it pauses again.
  await db.update(ConnectorTargetTable).set({ updatedAt: new Date() }).where(eq(ConnectorTargetTable.id, missingMetadata.id))
  const afterEdit = await reconcileGithubConnectorTargets(new Date(now.getTime() + 2 * DAY_MS))
  assert.deepEqual(afterEdit, { checked: 1, enqueued: 0, probed: 1 })
  targets = await readTargets()
  assert.equal(readGithubReconcileState(targets.get(missingMetadata.id)?.targetConfigJson)?.status, "paused")
  assert.equal(readGithubReconcileState(targets.get(missingMetadata.id)?.targetConfigJson)?.failureCount, 2)

  const events = await db.select({ id: ConnectorSyncEventTable.id }).from(ConnectorSyncEventTable).where(inArray(ConnectorSyncEventTable.connectorTargetId, targetIds))
  assert.equal(events.length, 0, "no sync was queued for a target that cannot sync")
})
