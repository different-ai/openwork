import type { CapabilityUsageSource } from "@openwork-ee/den-db/schema"

export const libraryUsageKinds = ["skills", "plugins", "connectors"] as const
export type LibraryUsageKind = (typeof libraryUsageKinds)[number]

export const libraryUsageDimensions = ["item", "member", "day"] as const
export type LibraryUsageDimension = (typeof libraryUsageDimensions)[number]

export type LibraryUsageSourceCounts = Partial<Record<CapabilityUsageSource, number>>

const DAY_MS = 86_400_000

export function libraryUsageWindow(days: number, now = new Date()): { from: Date; fromDate: string; toDate: string } {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const from = new Date(today - (days - 1) * DAY_MS)
  return { from, fromDate: from.toISOString().slice(0, 10), toDate: new Date(today).toISOString().slice(0, 10) }
}

export type LibraryUsageRow = {
  id: string
  name: string
  detail: string | null
  pluginId: string | null
  uses: number
  people: number
  failures: number | null
  lastUsedAt: string | null
}

export type LibraryUsageReport = {
  kind: LibraryUsageKind
  days: number
  trackingSince: string | null
  items: LibraryUsageRow[]
}

export type LibraryItem = { id: string; name: string; detail: string | null; pluginId: string | null; tracksFailures: boolean }

export type ItemUsageTotals = { itemId: string; uses: number; people: number; failures: number; lastUsedAt: Date | null }

export function buildLibraryUsageRows(items: readonly LibraryItem[], totals: readonly ItemUsageTotals[]): LibraryUsageRow[] {
  const byItem = new Map(totals.map((entry) => [entry.itemId, entry]))
  return items
    .map((item) => {
      const used = byItem.get(item.id)
      return {
        id: item.id,
        name: item.name,
        detail: item.detail,
        pluginId: item.pluginId,
        uses: used?.uses ?? 0,
        people: used?.people ?? 0,
        failures: item.tracksFailures ? used?.failures ?? 0 : null,
        lastUsedAt: used?.lastUsedAt ? used.lastUsedAt.toISOString() : null,
      }
    })
    .sort((a, b) => b.uses - a.uses || b.people - a.people || a.name.localeCompare(b.name))
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
