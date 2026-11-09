/**
 * GitHub reconcile state lives in connector_target_reconcile, one row per
 * target. A broken target backs off, one that needs a person pauses until the
 * connector changes, and state written by earlier releases into the target's
 * config carries over.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { GithubConnectorRequestError } from "../src/routes/org/plugin-system/github-app.js"
import {
  GITHUB_RECONCILE_ERROR_MAX_LENGTH,
  GITHUB_RECONCILE_MAX_BACKOFF_MS,
  githubReconcileRevisionAt,
  GithubReconcilePermanentError,
  nextGithubReconcileState,
  readLegacyGithubReconcileState,
  type GithubReconcileState,
} from "../src/workers/github-reconcile-state.js"

const HOUR_MS = 60 * 60_000
const MIN_AGE_MS = 6 * HOUR_MS
const now = new Date("2026-10-29T18:00:00.000Z")
const revisionAt = githubReconcileRevisionAt({
  accountUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
  instanceUpdatedAt: new Date("2026-10-02T00:00:00.000Z"),
  targetUpdatedAt: new Date("2026-10-03T00:00:00.000Z"),
})

function probe(previous: GithubReconcileState | null, error?: unknown, at = now) {
  return nextGithubReconcileState({ failure: error === undefined ? undefined : { error }, minAgeMs: MIN_AGE_MS, now: at, previous, revisionAt })
}

test("the revision is the latest edit to the target, its instance or its account", () => {
  assert.equal(revisionAt.toISOString(), "2026-10-03T00:00:00.000Z")
})

test("a healthy target is due again after the min age", () => {
  const state = probe(null)
  assert.equal(state.status, "ok")
  assert.equal(state.nextProbeAt?.getTime(), now.getTime() + MIN_AGE_MS)
  assert.equal(state.lastProbedAt?.getTime(), now.getTime())
})

test("repeated failures back off exponentially up to a week, and one success resets them", () => {
  const unavailable = new GithubConnectorRequestError("Server Error", 502)
  let state: GithubReconcileState | null = null
  const delaysHours: number[] = []
  for (let attempt = 0; attempt < 8; attempt += 1) {
    state = probe(state, unavailable)
    assert.equal(state.status, "retrying")
    delaysHours.push(((state.nextProbeAt?.getTime() ?? 0) - now.getTime()) / HOUR_MS)
  }
  assert.deepEqual(delaysHours, [6, 12, 24, 48, 96, 168, 168, 168])
  assert.equal(GITHUB_RECONCILE_MAX_BACKOFF_MS, 168 * HOUR_MS)
  assert.equal(state?.failureCount, 8)

  const recovered = probe(state)
  assert.equal(recovered.status, "ok")
  assert.equal(recovered.failureCount, 0)
  assert.equal(recovered.error, null)
})

test("a missing repository, branch, metadata or creator pauses the target at its current revision", () => {
  for (const error of [
    new GithubConnectorRequestError("Not Found", 404),
    new GithubConnectorRequestError("No commit found for SHA: master", 422),
    new GithubReconcilePermanentError("GitHub connector target is missing repository, branch, or installation metadata."),
    new GithubReconcilePermanentError("Connector creator member not found."),
  ]) {
    const paused = probe(null, error)
    assert.equal(paused.status, "paused", error.message)
    assert.equal(paused.error, error.message)
    assert.equal(paused.nextProbeAt, null, "never due while nothing changed")
    assert.equal(paused.pausedRevisionAt?.getTime(), revisionAt.getTime())
  }

  // Rate limits, auth trouble and outages are not the target's fault.
  for (const status of [401, 403, 429, 500]) {
    assert.equal(probe(null, new GithubConnectorRequestError("GitHub request failed.", status)).status, "retrying", String(status))
  }
  assert.equal(probe(null, new TypeError("fetch failed")).status, "retrying")
})

test("errors are cut to fit the error column", () => {
  const state = probe(null, new Error("x".repeat(5000)))
  assert.equal(state.error?.length, GITHUB_RECONCILE_ERROR_MAX_LENGTH)
})

test("state stored in the target's config by earlier releases carries over", () => {
  const retrying = readLegacyGithubReconcileState(JSON.stringify({
    error: "Server Error", failureCount: 2, lastProbedAt: "2026-10-29T12:00:00.000Z",
    nextProbeAt: "2026-10-30T00:00:00.000Z", pausedRevision: null, status: "retrying",
  }))
  assert.deepEqual(retrying, {
    error: "Server Error", failureCount: 2, lastProbedAt: new Date("2026-10-29T12:00:00.000Z"),
    nextProbeAt: new Date("2026-10-30T00:00:00.000Z"), pausedRevisionAt: null, status: "retrying",
  })

  const target = Date.parse("2026-10-03T00:00:00.000Z")
  const instance = Date.parse("2026-10-05T00:00:00.000Z")
  const account = Date.parse("2026-10-01T00:00:00.000Z")
  const paused = readLegacyGithubReconcileState({
    error: "Not Found", failureCount: 1, lastProbedAt: "2026-10-29T12:00:00.000Z",
    nextProbeAt: "2026-10-29T12:00:00.000Z", pausedRevision: `${target}:${instance}:${account}`, status: "paused",
  })
  assert.equal(paused?.status, "paused")
  assert.equal(paused?.nextProbeAt, null)
  assert.equal(paused?.pausedRevisionAt?.getTime(), instance, "the latest of the three edits")

  for (const value of [null, "not json", "{}", JSON.stringify({ status: "ok" }), { status: "weird", lastProbedAt: "x", nextProbeAt: "y" }]) {
    assert.equal(readLegacyGithubReconcileState(value), null)
  }
})
