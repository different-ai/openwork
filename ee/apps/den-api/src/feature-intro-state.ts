import type { FeatureIntroEventType, FeatureIntroState } from "@openwork/types/den/feature-intros"

/**
 * Pure rules for feature intro state (packages/types/src/den/feature-intros.ts), kept apart from the
 * database so they are tested on their own (test/feature-intro-state.test.ts).
 */
export type FeatureIntroTimestamps = {
  introVersion: number
  firstSeenAt: Date | null
  lastSeenAt: Date | null
  dismissedAt: Date | null
  ctaClickedAt: Date | null
  completedAt: Date | null
}

const EMPTY_TIMESTAMPS = { firstSeenAt: null, lastSeenAt: null, dismissedAt: null, ctaClickedAt: null, completedAt: null } as const

/**
 * The state after one event, or null when nothing changes (an event for an older intro version than the one
 * stored). A newer version starts from empty timestamps, so the intro shows again.
 */
export function applyFeatureIntroEvent(
  current: FeatureIntroTimestamps | null,
  event: { introVersion: number; type: FeatureIntroEventType },
  now: Date,
): FeatureIntroTimestamps | null {
  if (current && event.introVersion < current.introVersion) return null
  const base: FeatureIntroTimestamps = current && event.introVersion === current.introVersion
    ? current
    : { introVersion: event.introVersion, ...EMPTY_TIMESTAMPS }
  switch (event.type) {
    case "seen":
      return { ...base, firstSeenAt: base.firstSeenAt ?? now, lastSeenAt: now }
    case "dismissed":
      return { ...base, dismissedAt: now }
    case "cta_clicked":
      return { ...base, ctaClickedAt: now }
  }
}

export function featureIntroStateView(introKey: string, row: FeatureIntroTimestamps): FeatureIntroState {
  return {
    introKey,
    introVersion: row.introVersion,
    firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    ctaClickedAt: row.ctaClickedAt?.toISOString() ?? null,
  }
}
