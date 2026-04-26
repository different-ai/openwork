type OtelApi = typeof import("@opentelemetry/api");

let pending: Promise<OtelApi | null> | undefined;

export function getOtelApi(): Promise<OtelApi | null> {
  if (!pending) {
    pending = import("@opentelemetry/api").catch(() => null);
  }
  return pending;
}

export function resetOtelApiCacheForTesting(): void {
  pending = undefined;
}
