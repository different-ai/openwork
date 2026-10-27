import {
  DESKTOP_STARTUP_STEPS,
  desktopStartupFailureReasonSchema,
  desktopStartupStepSchema,
  type DesktopDiagnostics,
  type DesktopStartupFailureReason,
  type DesktopStartupStep,
} from "@openwork/types/den/diagnostics"

/** Pure startup math for Settings › Diagnostics. No database or network access. */

export const DESKTOP_STARTUP_WINDOW_HOURS = 24
export const DESKTOP_STARTUP_WINDOW_MS = DESKTOP_STARTUP_WINDOW_HOURS * 3_600_000
/** Reports for older launches are accepted (a failed launch is sent on the next one) up to this age. */
export const DESKTOP_STARTUP_MAX_AGE_MS = 7 * 86_400_000
export const DESKTOP_STARTUP_MAX_FUTURE_MS = 5 * 60_000
export const DESKTOP_STARTUP_RETENTION_MS = 30 * 86_400_000
/** Bounded read for one aggregation; percentiles are computed in memory. */
export const DESKTOP_STARTUP_AGGREGATE_LIMIT = 5_000

export type DesktopStartupRow = {
  orgMembershipId: string
  appVersion: string
  success: boolean
  failedStep: string | null
  failureReason: string | null
  windowMs: number | null
  engineMs: number | null
  signedInMs: number | null
  orgToolsMs: number | null
  observedAt: Date
}

/** Whether a report's launch time is inside the accepted ingest window. */
export function desktopStartupObservedAtAccepted(observedAt: Date, now: number): boolean {
  const at = observedAt.getTime()
  return Number.isFinite(at) && at >= now - DESKTOP_STARTUP_MAX_AGE_MS && at <= now + DESKTOP_STARTUP_MAX_FUTURE_MS
}

/** Nearest-rank percentile of non-empty values, rounded to whole milliseconds. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return Math.round(sorted[rank - 1])
}

function stepTimestamps(row: DesktopStartupRow): Record<DesktopStartupStep, number | null> {
  return { window: row.windowMs, engine: row.engineMs, signed_in: row.signedInMs, org_tools: row.orgToolsMs }
}

/**
 * Time spent in each step of one launch. Steps are measured from process start
 * and may overlap, so each duration is the step's timestamp minus the previous
 * reached step's timestamp (window → engine → signed_in → org_tools), never negative.
 */
export function desktopStartupStepDurations(row: DesktopStartupRow): Record<DesktopStartupStep, number | null> {
  const timestamps = stepTimestamps(row)
  const durations: Record<DesktopStartupStep, number | null> = { window: null, engine: null, signed_in: null, org_tools: null }
  let previous = 0
  for (const step of DESKTOP_STARTUP_STEPS) {
    const at = timestamps[step]
    if (at === null) continue
    durations[step] = Math.max(0, at - previous)
    previous = at
  }
  return durations
}

function readStep(value: string | null): DesktopStartupStep | null {
  const parsed = desktopStartupStepSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function readReason(value: string | null): DesktopStartupFailureReason | null {
  const parsed = desktopStartupFailureReasonSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The desktop section for launches observed in the last 24 hours (rows outside the window are ignored). */
export function summarizeDesktopStartups(rows: readonly DesktopStartupRow[], now: number): DesktopDiagnostics {
  const since = now - DESKTOP_STARTUP_WINDOW_MS
  const recent = rows.filter((row) => row.observedAt.getTime() >= since && row.observedAt.getTime() <= now + DESKTOP_STARTUP_MAX_FUTURE_MS)
  const successful = recent.filter((row) => row.success)
  const totals = successful.flatMap((row) => row.orgToolsMs === null ? [] : [row.orgToolsMs])
  const durations = successful.map(desktopStartupStepDurations)

  const failures = new Map<string, { step: DesktopStartupStep; reason: DesktopStartupFailureReason; count: number; people: Set<string>; lastSeenAt: number }>()
  for (const row of recent) {
    if (row.success) continue
    const step = readStep(row.failedStep)
    const reason = readReason(row.failureReason)
    if (!step || !reason) continue
    const key = `${step}:${reason}`
    const entry = failures.get(key) ?? { step, reason, count: 0, people: new Set<string>(), lastSeenAt: 0 }
    entry.count += 1
    entry.people.add(row.orgMembershipId)
    entry.lastSeenAt = Math.max(entry.lastSeenAt, row.observedAt.getTime())
    failures.set(key, entry)
  }

  const versions = new Map<string, number>()
  for (const row of recent) versions.set(row.appVersion, (versions.get(row.appVersion) ?? 0) + 1)

  return {
    access: "granted",
    windowHours: DESKTOP_STARTUP_WINDOW_HOURS,
    startups: recent.length,
    connected: successful.length,
    failed: recent.length - successful.length,
    people: new Set(recent.map((row) => row.orgMembershipId)).size,
    typicalMs: percentile(totals, 0.5),
    slowestMs: percentile(totals, 0.95),
    steps: DESKTOP_STARTUP_STEPS.map((step) => ({
      step,
      typicalMs: percentile(durations.flatMap((entry) => {
        const value = entry[step]
        return value === null ? [] : [value]
      }), 0.5),
    })),
    failures: [...failures.values()]
      .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
      .slice(0, 20)
      .map((entry) => ({
        step: entry.step,
        reason: entry.reason,
        count: entry.count,
        people: entry.people.size,
        lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
      })),
    versions: [...versions.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([version, startups]) => ({ version, startups })),
  }
}

export function emptyDesktopDiagnostics(): DesktopDiagnostics {
  return summarizeDesktopStartups([], Date.now())
}
