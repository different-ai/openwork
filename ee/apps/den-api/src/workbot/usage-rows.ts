import {
  addWorkbotUsageSums,
  emptyWorkbotUsageSums,
  WORKBOT_USAGE_SURFACES,
  type WorkbotUsageResponse,
  type WorkbotUsageSums,
  type WorkbotUsageSurface,
} from "@openwork/types/den/workbot-usage"

// Pure shaping of Workbot usage (packages/types/src/den/workbot-usage.ts); the reads are in usage.ts.

export const WORKBOT_USAGE_DAY_MS = 86_400_000
/** People and models listed, most expensive first; totals always cover everyone. */
export const WORKBOT_USAGE_MEMBER_LIMIT = 50
export const WORKBOT_USAGE_MODEL_LIMIT = 20

export type WorkbotUsageSlice = WorkbotUsageSums & { day: string; surface: WorkbotUsageSurface; model: string }
export type WorkbotUsageMemberSums = WorkbotUsageSums & { memberId: string }

export function workbotUsageDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** The first UTC day of a window of `days` whole days that ends with today. */
export function workbotUsageWindowStart(now: Date, days: number): Date {
  return new Date(Math.floor(now.getTime() / WORKBOT_USAGE_DAY_MS) * WORKBOT_USAGE_DAY_MS - (days - 1) * WORKBOT_USAGE_DAY_MS)
}

function byCost<T extends WorkbotUsageSums>(a: T, b: T) {
  return b.costMicroUsd - a.costMicroUsd || b.requests - a.requests
}

function sumBy<K extends string>(slices: readonly WorkbotUsageSlice[], key: (slice: WorkbotUsageSlice) => K): Map<K, WorkbotUsageSums> {
  const sums = new Map<K, WorkbotUsageSums>()
  for (const slice of slices) {
    const into = sums.get(key(slice)) ?? emptyWorkbotUsageSums()
    addWorkbotUsageSums(into, slice)
    sums.set(key(slice), into)
  }
  return sums
}

/** Sums per member across sources (the folded days and the request logs not folded yet). */
export function mergeWorkbotUsageMembers(rows: readonly WorkbotUsageMemberSums[]): WorkbotUsageMemberSums[] {
  const members = new Map<string, WorkbotUsageMemberSums>()
  for (const row of rows) {
    const into = members.get(row.memberId) ?? { memberId: row.memberId, ...emptyWorkbotUsageSums() }
    addWorkbotUsageSums(into, row)
    members.set(row.memberId, into)
  }
  return [...members.values()].filter((member) => member.requests > 0).sort((a, b) => byCost(a, b) || a.memberId.localeCompare(b.memberId))
}

export function summarizeWorkbotUsage(input: {
  now: Date
  days: number
  since: string | null
  slices: readonly WorkbotUsageSlice[]
  /** Everyone with usage in the window, most expensive first (mergeWorkbotUsageMembers). */
  members: readonly WorkbotUsageMemberSums[]
  names: ReadonlyMap<string, { name: string | null; email: string | null }>
}): WorkbotUsageResponse {
  const start = workbotUsageWindowStart(input.now, input.days)
  const first = workbotUsageDay(start)
  const slices = input.slices.filter((slice) => slice.day >= first && slice.requests > 0)
  const totals = emptyWorkbotUsageSums()
  for (const slice of slices) addWorkbotUsageSums(totals, slice)
  const days = sumBy(slices, (slice) => slice.day)
  const surfaces = sumBy(slices, (slice) => slice.surface)
  const models = sumBy(slices, (slice) => slice.model)
  return {
    days: input.days,
    since: input.since,
    totals: { ...totals, members: input.members.length },
    daily: Array.from({ length: input.days }, (_, index) => {
      const day = workbotUsageDay(new Date(start.getTime() + index * WORKBOT_USAGE_DAY_MS))
      return { day, ...(days.get(day) ?? emptyWorkbotUsageSums()) }
    }),
    surfaces: WORKBOT_USAGE_SURFACES.flatMap((surface) => {
      const sums = surfaces.get(surface)
      return sums ? [{ surface, ...sums }] : []
    }),
    models: [...models].map(([model, sums]) => ({ model, ...sums })).sort((a, b) => byCost(a, b) || a.model.localeCompare(b.model)).slice(0, WORKBOT_USAGE_MODEL_LIMIT),
    members: input.members.slice(0, WORKBOT_USAGE_MEMBER_LIMIT).map((member) => ({
      ...member,
      name: input.names.get(member.memberId)?.name ?? null,
      email: input.names.get(member.memberId)?.email ?? null,
    })),
  }
}
