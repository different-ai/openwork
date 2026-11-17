import { createHash } from "node:crypto"
import {
  COMPUTER_FLEET_FAILURE_HOURS,
  COMPUTER_FLEET_LIST_LIMIT,
  COMPUTER_FLEET_STUCK_MINUTES,
  type AdminComputerFleet,
  type ComputerFleetAttention,
  type ComputerFleetSandbox,
  type ComputerFleetSource,
  type ComputerFleetState,
  type ComputerFleetStatus,
  type ComputerFleetTotals,
} from "@openwork/types/den/admin-computer-fleet"
import type { RunnerComputer, RunnerComputerFleet } from "../headless-runner/client.js"

/**
 * Turns the runner's list of computers (each in its provider's own words) into the admin page's fleet: one
 * vocabulary of states, what needs a look, whose it is, totals and an overall status. Pure: no clock, no I/O.
 */

/** A computer's key at its provider, from its conversation's session id (Computers.slug in headless-computer). */
export const computerKey = (sessionId: string) => `hc-${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`

export type ComputerOwner = { id: string; name: string }
const MINUTE_MS = 60_000
const EXPIRY_GRACE_MS = 10 * MINUTE_MS

const STATES: Record<string, ComputerFleetState> = {
  queued: "starting",
  provisioning: "starting",
  creating: "starting",
  starting: "starting",
  running: "running",
  pausing: "pausing",
  paused: "paused",
  stopped: "stopped",
  archived: "stopped",
  stopping: "stopping",
  terminating: "stopping",
  failed: "failed",
  error: "failed",
}

/** A provider's time as an ISO moment, or null when it is missing or not a time. */
function moment(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
const ms = (value: string | null) => (value === null ? null : Date.parse(value))
const whole = (value: number | null) => (value !== null && Number.isFinite(value) && value >= 0 ? Math.round(value) : null)

/** When the step a computer is in began, as near as its provider says: its last change, else its last activity. */
const stepStartedAt = (sandbox: ComputerFleetSandbox) => ms(sandbox.lastChangedAt) ?? ms(sandbox.lastActivityAt) ?? ms(sandbox.createdAt)

function attentionOf(sandbox: ComputerFleetSandbox, now: number): ComputerFleetAttention | null {
  if (sandbox.state === "failed") return "failed"
  const since = stepStartedAt(sandbox)
  const stuck = (minutes: number) => since !== null && now - since > minutes * MINUTE_MS
  if (sandbox.state === "starting" && stuck(COMPUTER_FLEET_STUCK_MINUTES.starting)) return "stuck_starting"
  if (sandbox.state === "pausing" && stuck(COMPUTER_FLEET_STUCK_MINUTES.pausing)) return "stuck_pausing"
  if (sandbox.state === "stopping" && stuck(COMPUTER_FLEET_STUCK_MINUTES.stopping)) return "stuck_stopping"
  const expires = ms(sandbox.expiresAt)
  if (expires !== null && now - expires > EXPIRY_GRACE_MS) return "expired"
  return null
}

function sandboxOf(raw: RunnerComputer, owners: ReadonlyMap<string, ComputerOwner>, now: number): ComputerFleetSandbox | null {
  const state = STATES[raw.status.toLowerCase()] ?? "unknown"
  const sandbox: ComputerFleetSandbox = {
    id: raw.id,
    source: raw.source,
    provider: raw.provider,
    pool: raw.pool?.slice(0, 200) ?? null,
    backend: raw.backend?.slice(0, 200) ?? null,
    region: raw.region?.slice(0, 200) ?? null,
    state,
    status: raw.status,
    statusReason: raw.statusReason?.slice(0, 300) || null,
    attention: null,
    cpu: whole(raw.cpu),
    memoryMb: whole(raw.memoryMb),
    diskGb: whole(raw.diskGb),
    createdAt: moment(raw.createdAt),
    lastChangedAt: moment(raw.updatedAt),
    startedAt: moment(raw.startedAt),
    pausedAt: moment(raw.pausedAt),
    lastActivityAt: moment(raw.lastActivityAt),
    expiresAt: moment(raw.expiresAt),
    endedAt: moment(raw.endedAt),
    organization: raw.key ? (owners.get(raw.key) ?? null) : null,
  }
  if (state === "failed") {
    // A failure ends a sandbox, and providers keep ended ones: only the last day's are news.
    const failedAt = ms(sandbox.endedAt) ?? ms(sandbox.lastChangedAt) ?? ms(sandbox.createdAt)
    if (failedAt === null || now - failedAt > COMPUTER_FLEET_FAILURE_HOURS * 60 * MINUTE_MS) return null
  }
  sandbox.attention = attentionOf(sandbox, now)
  return sandbox
}

/** Needing a look first, then the busiest states, then the most recently active. */
const STATE_ORDER: Record<ComputerFleetState, number> = { failed: 0, starting: 1, pausing: 2, stopping: 3, running: 4, unknown: 5, paused: 6, stopped: 7 }
function byUrgency(a: ComputerFleetSandbox, b: ComputerFleetSandbox) {
  const attention = Number(b.attention !== null) - Number(a.attention !== null)
  if (attention !== 0) return attention
  const state = STATE_ORDER[a.state] - STATE_ORDER[b.state]
  if (state !== 0) return state
  return (ms(b.lastActivityAt) ?? ms(b.createdAt) ?? 0) - (ms(a.lastActivityAt) ?? ms(a.createdAt) ?? 0) || a.id.localeCompare(b.id)
}

const emptyTotals = (): ComputerFleetTotals => ({ total: 0, running: 0, starting: 0, pausing: 0, paused: 0, stopped: 0, stopping: 0, failed: 0, attention: 0 })

function statusOf(sources: ComputerFleetSource[], sandboxes: ComputerFleetSandbox[], listTruncated: boolean): ComputerFleetStatus {
  const readable = sources.filter((source) => source.status !== "unsupported")
  if (readable.length === 0) return sources.length === 0 ? "not_configured" : "healthy"
  if (readable.every((source) => source.status === "unreachable")) return "unreachable"
  const poolDown = sources.some((source) => source.pools.some((pool) => pool.enabled && pool.health !== "healthy"))
  const stuck = sandboxes.some((sandbox) => sandbox.attention !== null && sandbox.attention.startsWith("stuck_"))
  if (readable.some((source) => source.status === "unreachable") || poolDown || stuck) return "alert"
  if (sandboxes.some((sandbox) => sandbox.attention !== null) || listTruncated || sources.some((source) => source.truncated)) return "warning"
  return "healthy"
}

export function notConfiguredComputerFleet(now: Date): AdminComputerFleet {
  return { status: "not_configured", generatedAt: now.toISOString(), runnerError: null, sources: [], sandboxes: [], listTruncated: false, totals: emptyTotals() }
}

/** The runner's list could not be read at all: nothing is known about any computer. */
export function unreadableComputerFleet(now: Date, error: string): AdminComputerFleet {
  return { ...notConfiguredComputerFleet(now), status: "unreachable", runnerError: error.slice(0, 40) }
}

export function computerFleetFrom(runner: RunnerComputerFleet, owners: ReadonlyMap<string, ComputerOwner>, now: Date): AdminComputerFleet {
  const at = now.getTime()
  const all = runner.sandboxes.flatMap((raw) => {
    const sandbox = sandboxOf(raw, owners, at)
    return sandbox ? [sandbox] : []
  }).sort(byUrgency)
  const totals = emptyTotals()
  for (const sandbox of all) {
    totals.total += 1
    if (sandbox.state !== "unknown") totals[sandbox.state] += 1
    if (sandbox.attention !== null) totals.attention += 1
  }
  const sources: ComputerFleetSource[] = runner.sources.map((source) => {
    const own = all.filter((sandbox) => sandbox.source === source.source)
    return {
      source: source.source,
      provider: source.provider,
      status: source.status,
      error: source.error,
      truncated: source.truncated,
      pools: source.pools.map((pool) => ({ name: pool.name, backend: pool.backend?.slice(0, 200) ?? null, region: pool.region?.slice(0, 200) ?? null, enabled: pool.enabled, health: pool.health })),
      counts: {
        total: own.length,
        running: own.filter((sandbox) => sandbox.state === "running").length,
        paused: own.filter((sandbox) => sandbox.state === "paused").length,
        attention: own.filter((sandbox) => sandbox.attention !== null).length,
      },
    }
  })
  const listTruncated = all.length > COMPUTER_FLEET_LIST_LIMIT
  return {
    status: statusOf(sources, all, listTruncated),
    generatedAt: now.toISOString(),
    runnerError: null,
    sources,
    sandboxes: all.slice(0, COMPUTER_FLEET_LIST_LIMIT),
    listTruncated,
    totals,
  }
}
