// Pure helpers for Library usage, kept free of database imports so they can be unit tested.

/** Loads of the same skill by the same member inside this window count once. */
export const SKILL_USE_DEDUPE_WINDOW_MS = 15 * 60_000

export function skillUseDedupeKey(use: { orgMembershipId: string; configObjectId: string; at?: Date }): string {
  const at = use.at ?? new Date()
  return `skill:${use.orgMembershipId}:${use.configObjectId}:${Math.floor(at.getTime() / SKILL_USE_DEDUPE_WINDOW_MS)}`
}

export const libraryUsageKinds = ["skills", "plugins", "connectors"] as const
export type LibraryUsageKind = (typeof libraryUsageKinds)[number]

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

/** One member's use of one item in the window, from any source. */
export type UsageFact = { itemId: string; memberId: string | null; uses: number; failures: number; lastUsedAt: Date | null }

/**
 * Joins every live item with its usage. Unused items come back with zeros, so
 * "nobody uses this" is a row, not an absence. Facts for items that no longer
 * exist are ignored. People are distinct members across all sources. Most used first.
 */
export function buildLibraryUsageRows(items: readonly LibraryItem[], facts: readonly UsageFact[]): LibraryUsageRow[] {
  const totals = new Map<string, { uses: number; failures: number; members: Set<string>; lastUsedAt: Date | null }>()
  for (const fact of facts) {
    const entry = totals.get(fact.itemId) ?? { uses: 0, failures: 0, members: new Set<string>(), lastUsedAt: null }
    entry.uses += fact.uses
    entry.failures += fact.failures
    if (fact.memberId && fact.uses > 0) entry.members.add(fact.memberId)
    if (fact.lastUsedAt && (!entry.lastUsedAt || fact.lastUsedAt > entry.lastUsedAt)) entry.lastUsedAt = fact.lastUsedAt
    totals.set(fact.itemId, entry)
  }
  return items
    .map((item) => {
      const used = totals.get(item.id)
      return {
        id: item.id,
        name: item.name,
        detail: item.detail,
        pluginId: item.pluginId,
        uses: used?.uses ?? 0,
        people: used?.members.size ?? 0,
        failures: item.tracksFailures ? used?.failures ?? 0 : null,
        lastUsedAt: used?.lastUsedAt ? used.lastUsedAt.toISOString() : null,
      }
    })
    .sort((a, b) => b.uses - a.uses || b.people - a.people || a.name.localeCompare(b.name))
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
