const DAY_MS = 86_400_000

export type FeatureOutcomeRange = {
  from: Date
  to: Date
  days: string[]
}

export function utcDay(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function featureOutcomeRange(days: number, now: Date): FeatureOutcomeRange {
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`)
  const from = new Date(today - (days - 1) * DAY_MS)
  return { from, to: now, days: Array.from({ length: days }, (_, index) => utcDay(from.getTime() + index * DAY_MS)) }
}

export type FeatureOutcomeUnit = "run" | "meeting" | "check" | "message"

export type FeatureOutcomeStatus = "succeeded" | "failed" | "skipped" | "running"

export type FeatureOutcomeRow = {
  organizationId: string
  day: string
  status: FeatureOutcomeStatus
  reason: string | null
  count: number
  delivered: number | null
  lastAt: Date
}

export type FeatureOutcomeCoverage = { from: Date; counts: "all" | "failed" }

export type FeatureOutcomeReading = {
  unit: FeatureOutcomeUnit
  rows: FeatureOutcomeRow[]
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
  reasons: FeatureOutcomeReason[]
  days: FeatureOutcomeDay[]
  coverage: FeatureOutcomeCoverage | null
  byOrganization: Map<string, FeatureOutcomeTotals>
}

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

export type FeatureHealth =
  | { status: "not_used" }
  | { status: "in_use" }
  | { status: "healthy" }
  | { status: "failing"; count: number }
  | { status: "limited"; count: number }
  | { status: "mostly_skipped" }

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
