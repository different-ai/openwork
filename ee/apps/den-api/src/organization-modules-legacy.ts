import type { FeatureKey, FeatureOverrides } from "@openwork/features"

/**
 * Feature keys whose per-organization `enabled = false` override is an org
 * opt-out that maps onto `organization.modules.disabled` (00-legacy-mapping §G.1,
 * discovery D43). Deployment rollout, kill switches and operator locks are not
 * org choices and are never copied. Grant features are never copied either.
 */
export const LEGACY_KILL_SWITCH_FEATURES = {
  "library.connectors": "mcpConnections",
  "org.installLinks": "installLinks",
} as const satisfies Record<string, FeatureKey>

export type LegacyKillSwitchModule = keyof typeof LEGACY_KILL_SWITCH_FEATURES
export const LEGACY_KILL_SWITCH_MODULES: readonly LegacyKillSwitchModule[] = ["library.connectors", "org.installLinks"]

/** §G.1: the modules an explicit `organization_feature` override of `false` turns off, sorted like `normalizeDisabledModules`. */
export function legacyDisabledModules(overrides: FeatureOverrides): LegacyKillSwitchModule[] {
  return LEGACY_KILL_SWITCH_MODULES.filter((module) => overrides[LEGACY_KILL_SWITCH_FEATURES[module]] === false)
}
