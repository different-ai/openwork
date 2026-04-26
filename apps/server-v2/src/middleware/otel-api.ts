// shared lazy loader for @opentelemetry/api
// caches the import promise so concurrent callers don't race

let pending: Promise<typeof import("@opentelemetry/api") | null> | undefined;

export function getTraceApi() {
  if (!pending) {
    pending = import("@opentelemetry/api").catch(() => null);
  }
  return pending;
}
