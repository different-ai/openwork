import { createHash } from "node:crypto"
import {
  COMPUTER_FLEET_EVENT_LIMIT,
  COMPUTER_FLEET_FAILURE_HOURS,
  COMPUTER_FLEET_IDLE_RUNNING_MINUTES,
  COMPUTER_FLEET_LIST_LIMIT,
  COMPUTER_FLEET_LONG_RUNNING,
  COMPUTER_FLEET_ORGANIZATION_LIMIT,
  COMPUTER_FLEET_QUIET_HOURS,
  COMPUTER_FLEET_STUCK_MINUTES,
  COMPUTER_FLEET_UNKNOWN_ORGANIZATION,
  type AdminComputerDetail,
  type AdminComputerFleet,
  type ComputerFleetAttention,
  type ComputerFleetAttentionCounts,
  type ComputerFleetEvent,
  type ComputerFleetSandbox,
  type ComputerFleetSettings,
  type ComputerFleetSource,
  type ComputerFleetState,
  type ComputerFleetStatus,
  type ComputerFleetTotals,
} from "@openwork/types/den/admin-computer-fleet"
import type { RunnerComputer, RunnerComputerDetail, RunnerComputerFleet, RunnerComputerSettings } from "../headless-runner/client.js"

/**
 * Turns the runner's list of computers (each in its provider's own words) into the admin page's fleet: one
 * vocabulary of states, what needs a look, whose it is, totals and an overall status. Pure: no clock, no I/O.
 */

/** A computer's key at its provider, from its conversation's session id (Computers.slug in headless-computer). */
export const computerKey = (sessionId: string) => `hc-${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`

/**
 * Whose a computer is. `activeAt`: when its conversation last had a turn or an open view (epoch ms), and
 * `turnRunning`: whether one is under way; both left out when Den does not say.
 */
export type ComputerOwner = { id: string; name: string; activeAt?: number | null; turnRunning?: boolean }
const MINUTE_MS = 60_000
const EXPIRY_GRACE_MS = 10 * MINUTE_MS
/** Past a provider's own idle rule, it has had this long to act on it. */
const PROVIDER_IDLE_GRACE_MS = 15 * MINUTE_MS

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

/**
 * How long a running computer may go unused before it is flagged: well past the runner's own pause, and past the
 * provider's idle rule for it where that is longer (a provider that stops idle computers itself is given its time).
 */
function idleRunningAfterMs(raw: Pick<RunnerComputer, "idleTimeoutSeconds">, settings: RunnerComputerSettings | null) {
  const runner = settings ? 3 * settings.idlePauseSeconds * 1000 : 0
  const provider = raw.idleTimeoutSeconds && raw.idleTimeoutSeconds > 0 ? raw.idleTimeoutSeconds * 1000 + PROVIDER_IDLE_GRACE_MS : 0
  return Math.max(COMPUTER_FLEET_IDLE_RUNNING_MINUTES * MINUTE_MS, runner, provider)
}

function attentionOf(sandbox: ComputerFleetSandbox, now: number, idleRunningAfter: number, owner: ComputerOwner | null): ComputerFleetAttention | null {
  if (sandbox.state === "failed") return "failed"
  const since = stepStartedAt(sandbox)
  const stuck = (minutes: number) => since !== null && now - since > minutes * MINUTE_MS
  if (sandbox.state === "starting" && stuck(COMPUTER_FLEET_STUCK_MINUTES.starting)) return "stuck_starting"
  if (sandbox.state === "pausing" && stuck(COMPUTER_FLEET_STUCK_MINUTES.pausing)) return "stuck_pausing"
  if (sandbox.state === "stopping" && stuck(COMPUTER_FLEET_STUCK_MINUTES.stopping)) return "stuck_stopping"
  const expires = ms(sandbox.expiresAt)
  if (expires !== null && now - expires > EXPIRY_GRACE_MS) return "expired"
  // The last sign of use: activity, or the start that put it in this state. Never guessed when the provider gives none.
  const used = ms(sandbox.lastActivityAt)
  if (sandbox.state === "running" && used !== null && now - Math.max(used, ms(sandbox.lastChangedAt) ?? 0) > idleRunningAfter) return "idle_running"
  // Its provider sees a desktop as always in use. Den knows better: the conversation has been quiet for hours.
  if (sandbox.state === "running" && owner && owner.turnRunning !== true && typeof owner.activeAt === "number" && now - owner.activeAt > COMPUTER_FLEET_QUIET_HOURS * 60 * MINUTE_MS) return "idle_running"
  // In use as far as its provider can tell, yet awake most of its life: something never lets it sleep.
  const created = ms(sandbox.createdAt)
  if (sandbox.state === "running" && sandbox.runSeconds !== null && created !== null) {
    const life = now - created
    if (life >= COMPUTER_FLEET_LONG_RUNNING.minAgeHours * 60 * MINUTE_MS && sandbox.runSeconds * 1000 > life * COMPUTER_FLEET_LONG_RUNNING.share) return "long_running"
  }
  return null
}

function sandboxOf(raw: RunnerComputer, owners: ReadonlyMap<string, ComputerOwner>, settings: RunnerComputerSettings | null, now: number, keepOldFailure = false): ComputerFleetSandbox | null {
  const state = STATES[raw.status.toLowerCase()] ?? "unknown"
  const owner = raw.key ? (owners.get(raw.key) ?? null) : null
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
    organization: owner ? { id: owner.id, name: owner.name } : null,
    image: raw.image?.slice(0, 200) || null,
    imageCurrent: raw.imageCurrent,
    runSeconds: whole(raw.runSeconds),
  }
  if (state === "failed" && !keepOldFailure) {
    // A failure ends a sandbox, and providers keep ended ones: only the last day's are news.
    const failedAt = ms(sandbox.endedAt) ?? ms(sandbox.lastChangedAt) ?? ms(sandbox.createdAt)
    if (failedAt === null || now - failedAt > COMPUTER_FLEET_FAILURE_HOURS * 60 * MINUTE_MS) return null
  }
  sandbox.attention = attentionOf(sandbox, now, idleRunningAfterMs(raw, settings), owner)
  return sandbox
}

const settingsOf = (settings: RunnerComputerSettings | null): ComputerFleetSettings | null => settings && {
  image: settings.image?.slice(0, 200) || null,
  idlePauseSeconds: whole(settings.idlePauseSeconds) ?? 0,
  keepDays: whole(settings.keepDays) ?? 0,
  persistent: settings.persistent,
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
const noAttention = (): ComputerFleetAttentionCounts => ({ failed: 0, stuck_starting: 0, stuck_pausing: 0, stuck_stopping: 0, expired: 0, idle_running: 0, long_running: 0 })

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
  return { status: "not_configured", generatedAt: now.toISOString(), runnerError: null, sources: [], sandboxes: [], listTruncated: false, totals: emptyTotals(), attentionCounts: noAttention(), organizations: [], unknownOrganization: 0 }
}

/** The runner's list could not be read at all: nothing is known about any computer. */
export function unreadableComputerFleet(now: Date, error: string): AdminComputerFleet {
  return { ...notConfiguredComputerFleet(now), status: "unreachable", runnerError: error.slice(0, 40) }
}

/**
 * `organization` narrows the list to one organization's computers (its id), or to those whose organization is not
 * known (`unknown`). Totals, sources and the status stay the whole fleet's either way.
 */
export function computerFleetFrom(runner: RunnerComputerFleet, owners: ReadonlyMap<string, ComputerOwner>, now: Date, organization: string | null = null): AdminComputerFleet {
  const at = now.getTime()
  const settings = new Map(runner.sources.map((source) => [source.source, source.settings]))
  const all = runner.sandboxes.flatMap((raw) => {
    const sandbox = sandboxOf(raw, owners, settings.get(raw.source) ?? null, at)
    return sandbox ? [sandbox] : []
  }).sort(byUrgency)
  const totals = emptyTotals()
  const attentionCounts = noAttention()
  for (const sandbox of all) {
    totals.total += 1
    if (sandbox.state !== "unknown") totals[sandbox.state] += 1
    if (sandbox.attention !== null) {
      totals.attention += 1
      attentionCounts[sandbox.attention] += 1
    }
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
      settings: settingsOf(source.settings),
    }
  })
  const byOrganization = new Map<string, { id: string; name: string; computers: number }>()
  let unknownOrganization = 0
  for (const sandbox of all) {
    if (!sandbox.organization) {
      unknownOrganization += 1
      continue
    }
    const entry = byOrganization.get(sandbox.organization.id) ?? { ...sandbox.organization, computers: 0 }
    entry.computers += 1
    byOrganization.set(entry.id, entry)
  }
  const listed = organization === null ? all
    : organization === COMPUTER_FLEET_UNKNOWN_ORGANIZATION ? all.filter((sandbox) => sandbox.organization === null)
    : all.filter((sandbox) => sandbox.organization?.id === organization)
  const listTruncated = listed.length > COMPUTER_FLEET_LIST_LIMIT
  return {
    // The whole fleet's: a filter narrows what is listed, not what is wrong.
    status: statusOf(sources, all, all.length > COMPUTER_FLEET_LIST_LIMIT),
    generatedAt: now.toISOString(),
    runnerError: null,
    sources,
    sandboxes: listed.slice(0, COMPUTER_FLEET_LIST_LIMIT),
    listTruncated,
    totals,
    attentionCounts,
    organizations: [...byOrganization.values()].sort((a, b) => b.computers - a.computers || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, COMPUTER_FLEET_ORGANIZATION_LIMIT),
    unknownOrganization,
  }
}

/** What Den knows of the conversation a computer belongs to. Never its name or content. */
export type ComputerConversation = {
  sessionId: string
  chat: "main" | "side" | null
  member: { id: string; name: string; email: string } | null
  createdAt: Date | null
  lastActiveAt: Date | null
  activeTurnSince: Date | null
}
/** What Workbot's server last reported about the computer, and what it saw happen to it, newest first. */
export type ComputerReports = {
  reported: { state: string; detail: string | null; at: Date | null } | null
  events: Array<{ at: Date; type: string; level: "info" | "warning" | "error"; message: string }>
}

const FAILURE = /fail|reject|retry|expired/
/** The gateway's details as `name: value` pairs, in a fixed order, so the same event always reads the same. */
function providerMessage(details: Record<string, string>) {
  return Object.keys(details).sort().map((name) => `${name}: ${details[name]}`).join(", ").slice(0, 600)
}

/**
 * One computer in full: the runner's read of its provider, with whose it is and what Den was told happened to it.
 * A failure from long ago is still shown here: someone followed a link to it.
 */
export function computerDetailFrom(detail: RunnerComputerDetail, owner: ComputerOwner | null, conversation: ComputerConversation | null, reports: ComputerReports, now: Date): AdminComputerDetail {
  const raw = detail.computer
  // Read now, not from the list's shared index: whether a turn is under way decides what this page says.
  const activity = conversation ? { activeAt: Math.max(conversation.lastActiveAt?.getTime() ?? 0, reports.reported?.at?.getTime() ?? 0) || null, turnRunning: conversation.activeTurnSince !== null } : {}
  const computer = sandboxOf(raw, raw.key && owner ? new Map([[raw.key, { ...owner, ...activity }]]) : new Map(), detail.settings, now.getTime(), true)
  if (!computer) throw new Error("a computer kept for its detail was dropped")
  const provider: ComputerFleetEvent[] = (detail.events ?? []).map((event) => ({
    at: moment(event.at),
    origin: "provider",
    type: event.action.slice(0, 60),
    level: event.outcome === "failure" || FAILURE.test(event.action) ? (event.action.includes("retry") ? "warning" : "error") : "info",
    message: providerMessage(event.details),
  }))
  const den: ComputerFleetEvent[] = reports.events.map((event) => ({ at: event.at.toISOString(), origin: "den", type: event.type.slice(0, 60), level: event.level, message: event.message.slice(0, 600) }))
  const events = [...provider, ...den].sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0)).slice(0, COMPUTER_FLEET_EVENT_LIMIT)
  const iso = (value: Date | null) => (value ? value.toISOString() : null)
  return {
    generatedAt: now.toISOString(),
    computer,
    key: raw.key?.slice(0, 200) ?? null,
    trust: raw.trust?.slice(0, 40) ?? null,
    attempts: whole(raw.attempts),
    idledAt: moment(raw.idledAt),
    resumeRequestedAt: moment(raw.resumeRequestedAt),
    slotReleased: raw.slotReleased,
    limits: {
      idleTimeoutSeconds: whole(raw.idleTimeoutSeconds),
      ttlSeconds: whole(detail.limits.ttlSeconds),
      maxRunSeconds: whole(detail.limits.maxRunSeconds),
      maxPausedSeconds: whole(detail.limits.maxPausedSeconds),
      autoDeleteSeconds: whole(detail.limits.autoDeleteSeconds),
      totalRunSeconds: whole(detail.limits.totalRunSeconds) ?? whole(raw.runSeconds),
    },
    profile: detail.limits.profile?.slice(0, 200) ?? null,
    classification: detail.limits.classification?.slice(0, 200) ?? null,
    capabilities: detail.limits.capabilities,
    preemptible: detail.limits.preemptible,
    settings: settingsOf(detail.settings),
    placement: detail.placement && {
      pool: detail.placement.pool?.slice(0, 200) ?? null,
      strategy: detail.placement.strategy?.slice(0, 200) ?? null,
      outcome: detail.placement.outcome?.slice(0, 40) ?? null,
      reason: detail.placement.reason?.slice(0, 300) ?? null,
      evaluatedAt: moment(detail.placement.evaluatedAt),
      policies: detail.placement.policies,
      candidates: detail.placement.candidates.map((candidate) => ({ ...candidate, trust: candidate.trust?.slice(0, 40) ?? null, rank: whole(candidate.rank), reasons: candidate.reasons.map((line) => line.slice(0, 300)) })),
    },
    conversation: conversation && {
      sessionId: conversation.sessionId,
      chat: conversation.chat,
      member: conversation.member,
      createdAt: iso(conversation.createdAt),
      lastActiveAt: iso(conversation.lastActiveAt),
      activeTurnSince: iso(conversation.activeTurnSince),
    },
    reported: reports.reported && { state: reports.reported.state, detail: reports.reported.detail, at: iso(reports.reported.at) },
    events,
    providerEventsError: detail.events === null ? (detail.eventsError ?? "unreachable") : null,
  }
}
