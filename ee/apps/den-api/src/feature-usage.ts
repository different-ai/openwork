import { featureUsageDay, recordFeatureUsage } from "@openwork-ee/den-db/organization-features"
import type { FeatureKey } from "@openwork/features"
import { db } from "./db.js"

type FeatureUsage = { organizationId: string; memberId: string; keys: readonly FeatureKey[] }
type RecordFeatureUsage = (input: FeatureUsage & { at: Date }) => Promise<void>
export type MarkFeaturesUsed = (input: FeatureUsage) => void

export function createFeatureUsageMarker(record: RecordFeatureUsage, now: () => Date = () => new Date()): MarkFeaturesUsed {
  let seenDay = ""
  const seen = new Set<string>()

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
      for (const key of keys) seen.delete(`${input.memberId}:${key}`)
      console.warn("[feature-usage]", { stage: "record", message: error instanceof Error ? error.message : String(error) })
    })
  }
}

export const markFeaturesUsed = createFeatureUsageMarker((input) => recordFeatureUsage(db, input))
