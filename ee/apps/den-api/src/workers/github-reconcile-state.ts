import { GithubConnectorRequestError } from "../routes/org/plugin-system/github-app.js"

export type GithubReconcileState = {
  status: "ok" | "retrying" | "paused"
  lastProbedAt: Date | null
  nextProbeAt: Date | null
  failureCount: number
  error: string | null
  pausedRevisionAt: Date | null
}

export const LEGACY_GITHUB_RECONCILE_STATE_KEY = "githubReconcile"
export const GITHUB_RECONCILE_MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000
export const GITHUB_RECONCILE_ERROR_MAX_LENGTH = 1024

export class GithubReconcilePermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GithubReconcilePermanentError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : null
}

export function githubReconcileRevisionAt(input: { accountUpdatedAt: Date; instanceUpdatedAt: Date; targetUpdatedAt: Date }) {
  return new Date(Math.max(input.targetUpdatedAt.getTime(), input.instanceUpdatedAt.getTime(), input.accountUpdatedAt.getTime()))
}

export function readLegacyGithubReconcileState(value: unknown): GithubReconcileState | null {
  const state = typeof value === "string" ? safeJsonParse(value) : value
  if (!isRecord(state)) return null
  const { status, failureCount, error, pausedRevision } = state
  if (status !== "ok" && status !== "retrying" && status !== "paused") return null
  const lastProbedAt = parseDate(state.lastProbedAt)
  const nextProbeAt = parseDate(state.nextProbeAt)
  if (!lastProbedAt || !nextProbeAt) return null
  const revisionParts = typeof pausedRevision === "string"
    ? pausedRevision.split(":").map(Number).filter((part) => Number.isFinite(part))
    : []
  const pausedRevisionAt = status === "paused" && revisionParts.length > 0 ? new Date(Math.max(...revisionParts)) : null
  return {
    status,
    lastProbedAt,
    nextProbeAt: status === "paused" ? null : nextProbeAt,
    failureCount: typeof failureCount === "number" && Number.isSafeInteger(failureCount) && failureCount > 0 ? failureCount : 0,
    error: typeof error === "string" ? error.slice(0, GITHUB_RECONCILE_ERROR_MAX_LENGTH) : null,
    pausedRevisionAt,
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function isPermanentGithubReconcileError(error: unknown) {
  if (error instanceof GithubReconcilePermanentError) return true
  return error instanceof GithubConnectorRequestError && (error.status === 400 || error.status === 404 || error.status === 422)
}

export function nextGithubReconcileState(input: {
  previous: Pick<GithubReconcileState, "failureCount"> | null
  now: Date
  minAgeMs: number
  revisionAt: Date
  failure?: { error: unknown }
}): GithubReconcileState {
  const lastProbedAt = input.now
  if (!input.failure) {
    return {
      error: null,
      failureCount: 0,
      lastProbedAt,
      nextProbeAt: new Date(input.now.getTime() + input.minAgeMs),
      pausedRevisionAt: null,
      status: "ok",
    }
  }

  const failureCount = (input.previous?.failureCount ?? 0) + 1
  const message = input.failure.error instanceof Error ? input.failure.error.message : String(input.failure.error)
  const error = message.slice(0, GITHUB_RECONCILE_ERROR_MAX_LENGTH)
  if (isPermanentGithubReconcileError(input.failure.error)) {
    return { error, failureCount, lastProbedAt, nextProbeAt: null, pausedRevisionAt: input.revisionAt, status: "paused" }
  }
  const backoffMs = Math.min(GITHUB_RECONCILE_MAX_BACKOFF_MS, input.minAgeMs * 2 ** (failureCount - 1))
  return {
    error,
    failureCount,
    lastProbedAt,
    nextProbeAt: new Date(input.now.getTime() + backoffMs),
    pausedRevisionAt: null,
    status: "retrying",
  }
}
