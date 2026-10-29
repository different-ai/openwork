import { GithubConnectorRequestError } from "../routes/org/plugin-system/github-app.js"

/**
 * Reconcile probe state for one GitHub connector target. It lives in the
 * target's config beside githubDiscoveryCache, so every den-api replica reads
 * the same state and a deploy or scale-up does not forget it.
 *
 * - ok: probed on the normal cadence.
 * - retrying: the last probes failed; the next one waits twice as long each time.
 * - paused: the failure needs a person (the repository or branch is gone, the
 *   metadata is incomplete, the connector's creator left). Not probed again
 *   until the connector, its instance or its account changes.
 */
export type GithubReconcileState = {
  status: "ok" | "retrying" | "paused"
  lastProbedAt: string
  nextProbeAt: string
  failureCount: number
  error: string | null
  pausedRevision: string | null
}

export const GITHUB_RECONCILE_STATE_KEY = "githubReconcile"
export const GITHUB_RECONCILE_MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000

export class GithubReconcilePermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GithubReconcilePermanentError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readGithubReconcileState(targetConfig: unknown): GithubReconcileState | null {
  const state = isRecord(targetConfig) ? targetConfig[GITHUB_RECONCILE_STATE_KEY] : null
  if (!isRecord(state)) return null
  const { status, lastProbedAt, nextProbeAt, failureCount, error, pausedRevision } = state
  if (status !== "ok" && status !== "retrying" && status !== "paused") return null
  if (typeof lastProbedAt !== "string" || typeof nextProbeAt !== "string") return null
  return {
    status,
    lastProbedAt,
    nextProbeAt,
    failureCount: typeof failureCount === "number" && Number.isSafeInteger(failureCount) && failureCount > 0 ? failureCount : 0,
    error: typeof error === "string" ? error : null,
    pausedRevision: typeof pausedRevision === "string" ? pausedRevision : null,
  }
}

/** Changes whenever someone edits or reconnects the connector. */
export function githubReconcileRevision(input: { accountUpdatedAt: Date; instanceUpdatedAt: Date; targetUpdatedAt: Date }) {
  return [input.targetUpdatedAt, input.instanceUpdatedAt, input.accountUpdatedAt].map((date) => date.getTime()).join(":")
}

/** 400 is an invalid stored name, 404 a repository or installation that is gone, 422 a branch with no commit. */
export function isPermanentGithubReconcileError(error: unknown) {
  if (error instanceof GithubReconcilePermanentError) return true
  return error instanceof GithubConnectorRequestError && (error.status === 400 || error.status === 404 || error.status === 422)
}

/** When the target is next due, or null while it is paused for this revision. */
export function githubReconcileDueAtMs(state: GithubReconcileState | null, revision: string): number | null {
  if (!state) return 0
  if (state.status === "paused") return state.pausedRevision === revision ? null : 0
  const nextProbeAtMs = Date.parse(state.nextProbeAt)
  return Number.isFinite(nextProbeAtMs) ? nextProbeAtMs : 0
}

/** Due targets, never-probed and longest-overdue first. */
export function selectGithubReconcileCandidates(input: {
  batchSize: number
  now: Date
  targets: Array<{ targetId: string; createdAtMs: number; dueAtMs: number | null }>
}): string[] {
  const nowMs = input.now.getTime()
  return input.targets
    .filter((target): target is typeof target & { dueAtMs: number } => target.dueAtMs !== null && target.dueAtMs <= nowMs)
    .sort((left, right) => left.dueAtMs - right.dueAtMs
      || left.createdAtMs - right.createdAtMs
      || left.targetId.localeCompare(right.targetId))
    .slice(0, Math.max(0, Math.floor(input.batchSize)))
    .map((target) => target.targetId)
}

/** Written before probing, so a replica that reads the target afterwards skips it. */
export function claimGithubReconcileState(input: {
  previous: GithubReconcileState | null
  now: Date
  minAgeMs: number
}): GithubReconcileState {
  return {
    error: null,
    failureCount: 0,
    pausedRevision: null,
    status: "ok",
    ...input.previous,
    lastProbedAt: input.now.toISOString(),
    nextProbeAt: new Date(input.now.getTime() + input.minAgeMs).toISOString(),
  }
}

export function nextGithubReconcileState(input: {
  previous: GithubReconcileState | null
  now: Date
  minAgeMs: number
  revision: string
  failure?: { error: unknown }
}): GithubReconcileState {
  const lastProbedAt = input.now.toISOString()
  if (!input.failure) {
    return {
      error: null,
      failureCount: 0,
      lastProbedAt,
      nextProbeAt: new Date(input.now.getTime() + input.minAgeMs).toISOString(),
      pausedRevision: null,
      status: "ok",
    }
  }

  const failureCount = (input.previous?.failureCount ?? 0) + 1
  const error = input.failure.error instanceof Error ? input.failure.error.message : String(input.failure.error)
  if (isPermanentGithubReconcileError(input.failure.error)) {
    return { error, failureCount, lastProbedAt, nextProbeAt: lastProbedAt, pausedRevision: input.revision, status: "paused" }
  }
  const backoffMs = Math.min(GITHUB_RECONCILE_MAX_BACKOFF_MS, input.minAgeMs * 2 ** (failureCount - 1))
  return {
    error,
    failureCount,
    lastProbedAt,
    nextProbeAt: new Date(input.now.getTime() + backoffMs).toISOString(),
    pausedRevision: null,
    status: "retrying",
  }
}
