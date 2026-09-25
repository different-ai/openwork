import { useSyncExternalStore } from "react";
import { coworkerBridge } from "@/lib/bridge";
import { DEFAULT_FEATURES, normalizeFeatures, type FeatureId, type Features } from "@/lib/features";

/**
 * The optional features, shared by every view. Read once from settings, then
 * kept current by the Features toggles themselves. Until the first read
 * lands, everything optional stays hidden, which is also the default.
 */
const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES) as FeatureId[];
let current: Features = DEFAULT_FEATURES;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Features) {
  if (FEATURE_KEYS.every((key) => next[key] === current[key])) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Read the saved features (again). */
export function refreshFeatures(): Promise<void> {
  loading ??= coworkerBridge.settings.get()
    .then((settings) => publish(normalizeFeatures(settings.features)))
    .catch(() => undefined)
    .finally(() => { loading = null; });
  return loading;
}

/** Turn one feature on or off; every view updates once the setting is saved. */
export async function setFeature(id: FeatureId, enabled: boolean): Promise<Features> {
  const settings = await coworkerBridge.settings.update({ features: { ...current, [id]: enabled } });
  const next = normalizeFeatures(settings.features);
  publish(next);
  return next;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void refreshFeatures();
  return () => { listeners.delete(listener); };
}

export function useFeatures(): Features {
  return useSyncExternalStore(subscribe, () => current);
}
