// Pure helpers for Library usage, kept free of database imports so they can be unit tested.
import type { CapabilityUsageSource } from "@openwork-ee/den-db/schema"

export const libraryUsageKinds = ["skills", "plugins", "connectors"] as const
export type LibraryUsageKind = (typeof libraryUsageKinds)[number]

/** What a usage breakdown can group by: the skill, plugin or connector, the member, and the UTC day. */
export const libraryUsageDimensions = ["item", "member", "day"] as const
export type LibraryUsageDimension = (typeof libraryUsageDimensions)[number]

/** Uses per source (agent, workflow, automation, app, artifact); a missing key is zero. */
export type LibraryUsageSourceCounts = Partial<Record<CapabilityUsageSource, number>>

const DAY_MS = 86_400_000

/**
 * The last `days` UTC calendar days, today included. Day boundaries are UTC
 * like every other Analytics read, and match the daily rollup buckets.
 */
export function libraryUsageWindow(days: number, now = new Date()): { from: Date; fromDate: string; toDate: string } {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const from = new Date(today - (days - 1) * DAY_MS)
  return { from, fromDate: from.toISOString().slice(0, 10), toDate: new Date(today).toISOString().slice(0, 10) }
}

/** One skill, plugin or connector and how it was used in the window. */
export type LibraryUsageRow = {
  id: string
  name: string
  /** A short second line: the plugin a skill belongs to, or what a plugin or connector holds. */
  detail: string | null
  /** The plugin a skill belongs to, for linking; null for plugins and connectors. */
  pluginId: string | null
  uses: number
  people: number
  /** Calls or runs that failed, for connectors and plugins' Workflows; null when failures are not known (skills). */
  failures: number | null
  lastUsedAt: string | null
}

export type LibraryUsageReport = {
  kind: LibraryUsageKind
  days: number
  /** When the organization's first recorded use happened; null before any. */
  trackingSince: string | null
  items: LibraryUsageRow[]
}

export type LibraryItem = { id: string; name: string; detail: string | null; pluginId: string | null; tracksFailures: boolean }

/** One item's totals in the window across every source; people are distinct members, counted by the database. */
export type ItemUsageTotals = { itemId: string; uses: number; people: number; failures: number; lastUsedAt: Date | null }

/**
 * Joins every live item with its usage. Unused items come back with zeros, so
 * "nobody uses this" is a row, not an absence. Totals for items that no longer
 * exist are ignored. Most used first.
 */
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
