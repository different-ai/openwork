import { featureUsageDay, recordFeatureUsage } from "@openwork-ee/den-db/organization-features"
import type { FeatureKey } from "@openwork/features"
import { db } from "./db.js"

type FeatureUsage = { organizationId: string; memberId: string; keys: readonly FeatureKey[] }
type RecordFeatureUsage = (input: FeatureUsage & { at: Date }) => Promise<void>
/** Marks that a member used features; never throws or waits (see createFeatureUsageMarker). */
export type MarkFeaturesUsed = (input: FeatureUsage) => void

/**
 * Who used which feature, for /admin. Best effort: never throws and never
 * delays the caller.
 *
 * Each replica writes at most once per member, feature and UTC day. The row
 * is idempotent per day, so another replica writing the same day only moves
 * last_used_at. The set is cleared when the day changes, so it holds at most
 * one day of active (member, feature) pairs.
 */
export function createFeatureUsageMarker(record: RecordFeatureUsage, now: () => Date = () => new Date()): MarkFeaturesUsed {
  let seenDay = ""
  const seen = new Set<string>()

  /** Features this member has not been recorded for today on this replica; marks them as recorded. */
  function unseenToday(memberId: string, keys: readonly FeatureKey[], day: string): FeatureKey[] {
    if (day !== seenDay) {
      seen.clear()
      seenDay = day
    }
    const fresh: FeatureKey[] = []
    for (const key of new Set(keys)) {
      const id = `${memberId}:${key}`
      if (seen.has(id)) continue
      seen.add(id)
      fresh.push(key)
    }
    return fresh
  }

  return function markFeaturesUsed(input: FeatureUsage): void {
    const at = now()
    const keys = unseenToday(input.memberId, input.keys, featureUsageDay(at))
    if (keys.length === 0) return
    void record({ organizationId: input.organizationId, memberId: input.memberId, keys, at }).catch((error: unknown) => {
      // Let a later request retry today.
      for (const key of keys) seen.delete(`${input.memberId}:${key}`)
      console.warn("[feature-usage]", { stage: "record", message: error instanceof Error ? error.message : String(error) })
    })
  }
}

/**
 * Records that a member used features: a gated route, a client report, or background work done for them (an
 * Automation's schedule firing, Your agent's check, a slack_send_as_bot message). See createFeatureUsageMarker.
 */
export const markFeaturesUsed = createFeatureUsageMarker((input) => recordFeatureUsage(db, input))
