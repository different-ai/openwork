/**
 * Every den-api replica runs the GitHub reconcile loop, so its probe state is
 * stored on the target and read back by whichever replica runs next. A broken
 * target backs off, and one that needs a person waits for an edit instead of
 * being probed again on every boot.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { GithubConnectorRequestError } from "../src/routes/org/plugin-system/github-app.js"
import {
  claimGithubReconcileState,
  GITHUB_RECONCILE_MAX_BACKOFF_MS,
  githubReconcileDueAtMs,
  githubReconcileRevision,
  GithubReconcilePermanentError,
  nextGithubReconcileState,
  readGithubReconcileState,
  selectGithubReconcileCandidates,
  type GithubReconcileState,
} from "../src/workers/github-reconcile-state.js"

const HOUR_MS = 60 * 60_000
const MIN_AGE_MS = 6 * HOUR_MS
const now = new Date("2026-10-29T18:00:00.000Z")
const revision = githubReconcileRevision({
  accountUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
  instanceUpdatedAt: new Date("2026-10-02T00:00:00.000Z"),
  targetUpdatedAt: new Date("2026-10-03T00:00:00.000Z"),
})

function probe(previous: GithubReconcileState | null, error?: unknown, at = now) {
  return nextGithubReconcileState({ failure: error === undefined ? undefined : { error }, minAgeMs: MIN_AGE_MS, now: at, previous, revision })
}

test("a healthy target is due again after the min age, whichever replica reads it", () => {
  const state = probe(null)
  assert.equal(state.status, "ok")
  // The state round-trips through the target's JSON config.
  const stored = readGithubReconcileState(JSON.parse(JSON.stringify({ branch: "main", githubReconcile: state })))
  assert.deepEqual(stored, state)
  assert.equal(githubReconcileDueAtMs(stored, revision), now.getTime() + MIN_AGE_MS)
  assert.equal(githubReconcileDueAtMs(null, revision), 0, "a target never probed is due now")
})

test("repeated failures back off exponentially up to a week, and one success resets them", () => {
  const unavailable = new GithubConnectorRequestError("Server Error", 502)
  let state: GithubReconcileState | null = null
  const delaysHours: number[] = []
  for (let attempt = 0; attempt < 8; attempt += 1) {
    state = probe(state, unavailable)
    assert.equal(state.status, "retrying")
    delaysHours.push((Date.parse(state.nextProbeAt) - now.getTime()) / HOUR_MS)
  }
  assert.deepEqual(delaysHours, [6, 12, 24, 48, 96, 168, 168, 168])
  assert.equal(GITHUB_RECONCILE_MAX_BACKOFF_MS, 168 * HOUR_MS)
  assert.equal(state?.failureCount, 8)

  const recovered = probe(state)
  assert.equal(recovered.status, "ok")
  assert.equal(recovered.failureCount, 0)
  assert.equal(recovered.error, null)
})

test("a missing repository, branch, metadata or creator pauses the target until the connector changes", () => {
  for (const error of [
    new GithubConnectorRequestError("Not Found", 404),
    new GithubConnectorRequestError("No commit found for SHA: master", 422),
    new GithubReconcilePermanentError("GitHub connector target is missing repository, branch, or installation metadata."),
    new GithubReconcilePermanentError("Connector creator member not found."),
  ]) {
    const paused = probe(null, error)
    assert.equal(paused.status, "paused", error.message)
    assert.equal(paused.error, error.message)
    assert.equal(githubReconcileDueAtMs(paused, revision), null, "never due while nothing changed")

    const edited = githubReconcileRevision({
      accountUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
      instanceUpdatedAt: new Date("2026-10-02T00:00:00.000Z"),
      targetUpdatedAt: new Date("2026-10-30T09:00:00.000Z"),
    })
    assert.equal(githubReconcileDueAtMs(paused, edited), 0, "due right after an edit or reconnect")
  }

  // Rate limits, auth trouble and outages are not the target's fault.
  for (const status of [401, 403, 429, 500]) {
    assert.equal(probe(null, new GithubConnectorRequestError("GitHub request failed.", status)).status, "retrying", String(status))
  }
  assert.equal(probe(null, new TypeError("fetch failed")).status, "retrying")
})

test("the claim pushes the next probe out before probing and keeps a pause until the outcome is known", () => {
  const paused = probe(null, new GithubConnectorRequestError("Not Found", 404))
  const claim = claimGithubReconcileState({ minAgeMs: MIN_AGE_MS, now: new Date(now.getTime() + HOUR_MS), previous: paused })
  assert.equal(claim.status, "paused")
  assert.equal(claim.pausedRevision, revision)
  assert.notEqual(claim.lastProbedAt, paused.lastProbedAt, "the claim changes the value other replicas compare against")
  assert.equal(Date.parse(claim.nextProbeAt), now.getTime() + HOUR_MS + MIN_AGE_MS)
})

test("a batch takes due targets only, never-probed and longest-overdue first", () => {
  const selected = selectGithubReconcileCandidates({
    batchSize: 3,
    now,
    targets: [
      { targetId: "paused", createdAtMs: 1, dueAtMs: null },
      { targetId: "later", createdAtMs: 2, dueAtMs: now.getTime() + 1 },
      { targetId: "overdue-recent", createdAtMs: 3, dueAtMs: now.getTime() - HOUR_MS },
      { targetId: "overdue-old", createdAtMs: 4, dueAtMs: now.getTime() - 5 * HOUR_MS },
      { targetId: "new-b", createdAtMs: 6, dueAtMs: 0 },
      { targetId: "new-a", createdAtMs: 5, dueAtMs: 0 },
    ],
  })
  assert.deepEqual(selected, ["new-a", "new-b", "overdue-old"])
})
