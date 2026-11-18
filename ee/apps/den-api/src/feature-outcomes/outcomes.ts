/**
 * The shape every feature's outcome reader returns, and the pure rules that
 * turn it into what /admin › Features shows: totals, reasons, a per-day series,
 * a by-organization breakdown and one health state. Readers only aggregate the
 * store that already owns the outcomes (readers.ts); nothing here does I/O.
 * Counts and reason codes only: never meeting titles, names or message text.
 */

const DAY_MS = 86_400_000

/** Whole UTC days ending today: the range /admin › Features counts in. */
export type FeatureOutcomeRange = {
  /** Start of the first UTC day. */
  from: Date
  to: Date
  /** "YYYY-MM-DD" for every UTC day in the range, oldest first. */
  days: string[]
}

export function utcDay(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** The last `days` UTC days, today included. */
export function featureOutcomeRange(days: number, now: Date): FeatureOutcomeRange {
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`)
  const from = new Date(today - (days - 1) * DAY_MS)
  return { from, to: now, days: Array.from({ length: days }, (_, index) => utcDay(from.getTime() + index * DAY_MS)) }
}

/** What one of the feature's runs is, so /admin can say "Most meetings skipped". */
export type FeatureOutcomeUnit = "run" | "meeting" | "check" | "message"

export type FeatureOutcomeStatus = "succeeded" | "failed" | "skipped" | "running"

/** One group of outcomes a reader found: an organization, a UTC day, how they ended and why. */
export type FeatureOutcomeRow = {
  organizationId: string
  day: string
  /** `running`: started and not finished yet; it counts as a run only. */
  status: FeatureOutcomeStatus
  /** A reason code for failed and skipped rows, never free text. */
  reason: string | null
  count: number
  /** Of `count`, how many reached the member; null when the store does not say. */
  delivered: number | null
  lastAt: Date
}

/** When the store keeps less than the range: from when, and which counts that limits. */
export type FeatureOutcomeCoverage = { from: Date; counts: "all" | "failed" }

export type FeatureOutcomeReading = {
  unit: FeatureOutcomeUnit
  rows: FeatureOutcomeRow[]
  /** Members held back by a limit in the range, by organization; null when the feature has no limit. */
  limited: Map<string, number> | null
  coverage: FeatureOutcomeCoverage | null
}

export type FeatureOutcomeReader = (range: FeatureOutcomeRange) => Promise<FeatureOutcomeReading>

export type FeatureOutcomeTotals = {
  runs: number
  succeeded: number
  failed: number
  skipped: number
  delivered: number | null
  limited: number | null
  lastRunAt: Date | null
}

export type FeatureOutcomeReason = { reason: string; outcome: "failed" | "skipped"; count: number }

export type FeatureOutcomeDay = { day: string; runs: number; failed: number }

export type FeatureOutcomeSummary = FeatureOutcomeTotals & {
  unit: FeatureOutcomeUnit
  /** Failed and skipped runs by reason, most first. */
  reasons: FeatureOutcomeReason[]
  /** Every day of the range, oldest first, zero when nothing ran. */
  days: FeatureOutcomeDay[]
  coverage: FeatureOutcomeCoverage | null
  byOrganization: Map<string, FeatureOutcomeTotals>
}

/** Nothing happened; `limited` is 0 for a feature that has a limit, null otherwise. */
export function emptyFeatureOutcomeTotals(limited: boolean): FeatureOutcomeTotals {
  return { runs: 0, succeeded: 0, failed: 0, skipped: 0, delivered: null, limited: limited ? 0 : null, lastRunAt: null }
}

function add(totals: FeatureOutcomeTotals, row: FeatureOutcomeRow) {
  totals.runs += row.count
  if (row.status === "succeeded") totals.succeeded += row.count
  if (row.status === "failed") totals.failed += row.count
  if (row.status === "skipped") totals.skipped += row.count
  if (row.delivered !== null) totals.delivered = (totals.delivered ?? 0) + row.delivered
  if (!totals.lastRunAt || row.lastAt > totals.lastRunAt) totals.lastRunAt = row.lastAt
}

/** Totals, reasons, the day series and the by-organization breakdown of one reading. Rows outside the range are ignored. */
export function summarizeFeatureOutcomes(reading: FeatureOutcomeReading, range: FeatureOutcomeRange): FeatureOutcomeSummary {
  const inRange = new Set(range.days)
  const hasLimit = reading.limited !== null
  const totals = emptyFeatureOutcomeTotals(hasLimit)
  const byOrganization = new Map<string, FeatureOutcomeTotals>()
  const reasons = new Map<string, FeatureOutcomeReason>()
  const days = new Map(range.days.map((day) => [day, { day, runs: 0, failed: 0 }]))
  for (const row of reading.rows) {
    if (!inRange.has(row.day) || row.count <= 0) continue
    add(totals, row)
    const organization = byOrganization.get(row.organizationId) ?? emptyFeatureOutcomeTotals(hasLimit)
    add(organization, row)
    byOrganization.set(row.organizationId, organization)
    const day = days.get(row.day)
    if (day) {
      day.runs += row.count
      if (row.status === "failed") day.failed += row.count
    }
    if (row.status === "failed" || row.status === "skipped") {
      const reason = row.reason ?? "unknown"
      const key = `${row.status}:${reason}`
      const entry = reasons.get(key) ?? { reason, outcome: row.status, count: 0 }
      entry.count += row.count
      reasons.set(key, entry)
    }
  }
  for (const [organizationId, members] of reading.limited ?? []) {
    if (members <= 0) continue
    totals.limited = (totals.limited ?? 0) + members
    const organization = byOrganization.get(organizationId) ?? emptyFeatureOutcomeTotals(true)
    organization.limited = (organization.limited ?? 0) + members
    byOrganization.set(organizationId, organization)
  }
  return {
    ...totals,
    unit: reading.unit,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    days: [...days.values()],
    coverage: reading.coverage,
    byOrganization,
  }
}

/**
 * One plain state per feature. Failures outrank limits, limits outrank skips;
 * a feature with no reader only knows whether anyone used it.
 */
export type FeatureHealth =
  | { status: "not_used" }
  | { status: "in_use" }
  | { status: "healthy" }
  | { status: "failing"; count: number }
  | { status: "limited"; count: number }
  | { status: "mostly_skipped" }

/** A feature is failing once at least one in five finished runs that did run failed. */
const FAILING_SHARE = 0.2

export function featureHealth(input: { membersUsing: number; outcomes: FeatureOutcomeTotals | null }): FeatureHealth {
  const { outcomes, membersUsing } = input
  if (!outcomes) return membersUsing > 0 ? { status: "in_use" } : { status: "not_used" }
  if (outcomes.runs === 0 && !outcomes.limited) return membersUsing > 0 ? { status: "in_use" } : { status: "not_used" }
  const ran = outcomes.succeeded + outcomes.failed
  if (outcomes.failed > 0 && outcomes.failed >= ran * FAILING_SHARE) return { status: "failing", count: outcomes.failed }
  if (outcomes.limited) return { status: "limited", count: outcomes.limited }
  if (outcomes.skipped * 2 > ran + outcomes.skipped) return { status: "mostly_skipped" }
  return { status: "healthy" }
}
