/**
 * The GitHub sync poll reads one bounded page of due events, never the events
 * waiting behind a target that is already syncing, and puts back running events
 * a replica abandoned. One claimed sync closes the events queued before it for
 * the same target, because it imports the branch as it is when it runs.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const HOUR_MS = 60 * 60_000

test("a poll reads a bounded page of unblocked events, reclaims abandoned ones and supersedes covered ones", async () => {
  const { db } = await import("../../src/db.js")
  const { ConnectorSyncEventTable } = await import("@openwork-ee/den-db/schema")
  const { eq, inArray } = await import("@openwork-ee/den-db/drizzle")
  const { GITHUB_SYNC_POLL_LIMIT, processDueGithubSyncEvents } = await import("../../src/workers/github-sync.js")

  const { orgId } = await den.createOrg(await den.signUp("Gil Github"), "GitHub sync org")
  const now = new Date()
  const connectorInstanceId = createDenTypeId("connectorInstance")
  const event = (input: { target: string; status: "queued" | "running"; startedAt: Date; nextAttemptAt?: Date | null }) => ({
    connectorInstanceId,
    connectorTargetId: input.target as ReturnType<typeof createDenTypeId<"connectorTarget">>,
    connectorType: "github" as const,
    eventType: "push" as const,
    id: createDenTypeId("connectorSyncEvent"),
    nextAttemptAt: input.nextAttemptAt ?? null,
    organizationId: orgId as ReturnType<typeof createDenTypeId<"organization">>,
    startedAt: input.startedAt,
    status: input.status,
    summaryJson: { trigger: "test" },
  })

  // Target A: a running event a replica abandoned two days ago (claimed before
  // leases existed), and two pushes queued behind it.
  const targetA = createDenTypeId("connectorTarget")
  const abandoned = event({ target: targetA, status: "running", startedAt: new Date(now.getTime() - 48 * HOUR_MS) })
  const behindA = [
    event({ target: targetA, status: "queued", startedAt: new Date(now.getTime() - 47 * HOUR_MS) }),
    event({ target: targetA, status: "queued", startedAt: new Date(now.getTime() - 46 * HOUR_MS) }),
  ]
  // Target B: syncing right now under a live lease, with a push queued behind it.
  const targetB = createDenTypeId("connectorTarget")
  const live = event({ target: targetB, status: "running", startedAt: new Date(now.getTime() - 40 * HOUR_MS), nextAttemptAt: new Date(now.getTime() + HOUR_MS) })
  const behindB = event({ target: targetB, status: "queued", startedAt: new Date(now.getTime() - 45 * HOUR_MS) })
  // More due events, each on its own target, than one page holds.
  const others = Array.from({ length: GITHUB_SYNC_POLL_LIMIT + 5 }, (_, index) =>
    event({ target: createDenTypeId("connectorTarget"), status: "queued", startedAt: new Date(now.getTime() - (30 - index / 10) * HOUR_MS) }))
  await db.insert(ConnectorSyncEventTable).values([abandoned, ...behindA, live, behindB, ...others])

  const result = await processDueGithubSyncEvents(now)
  assert.equal(result.checked, GITHUB_SYNC_POLL_LIMIT, "one poll reads one page")
  assert.equal(result.superseded, 2, "the reclaimed sync covers both pushes queued behind it")

  const rows = await db.select().from(ConnectorSyncEventTable)
    .where(inArray(ConnectorSyncEventTable.id, [abandoned.id, ...behindA.map((row) => row.id), live.id, behindB.id]))
  const byId = new Map(rows.map((row) => [row.id, row]))

  // The abandoned event was put back, claimed again and ran. The test target
  // has no connector instance, so the run fails for good, as it would in prod.
  assert.equal(byId.get(abandoned.id)?.status, "failed")
  assert.equal(byId.get(abandoned.id)?.attemptCount, 2, "reclaiming it counted an attempt, and so did the failed run")
  for (const covered of behindA) {
    const row = byId.get(covered.id)
    assert.equal(row?.status, "ignored")
    assert.deepEqual(row?.summaryJson, { trigger: "test", outcome: "superseded", supersededBy: abandoned.id })
  }

  // A live lease is left alone, and the push behind it waits untouched.
  assert.equal(byId.get(live.id)?.status, "running")
  assert.equal(byId.get(behindB.id)?.status, "queued")
  assert.equal(byId.get(behindB.id)?.attemptCount, 0)

  // Events outside the page are still queued for the next poll.
  const stillQueued = await db.select({ id: ConnectorSyncEventTable.id }).from(ConnectorSyncEventTable)
    .where(eq(ConnectorSyncEventTable.status, "queued"))
  assert.ok(stillQueued.some((row) => others.some((other) => other.id === row.id)), "a later page is left for the next poll")
})
