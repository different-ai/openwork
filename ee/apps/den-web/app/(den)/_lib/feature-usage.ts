import type { FeatureKey } from "@openwork/features";
import { requestJson } from "./den-flow";

const FLUSH_DELAY_MS = 2_000;
const reported = new Set<FeatureKey>();
const pending = new Set<FeatureKey>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const features = [...pending];
  pending.clear();
  if (features.length === 0) return;
  void requestJson("/v1/org/feature-usage", { method: "POST", body: JSON.stringify({ features }), keepalive: true }, 10_000).catch(() => {
    // Best effort: a lost report only hides one use from /admin.
  });
}

/** Report that the member just used a feature, for /admin; call where the feature is exercised, not on render. Batched, once per key per page load. */
export function markFeatureUsed(key: FeatureKey): void {
  if (typeof window === "undefined" || reported.has(key)) return;
  reported.add(key);
  pending.add(key);
  timer ??= setTimeout(flush, FLUSH_DELAY_MS);
}
