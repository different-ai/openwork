import { TelemetryEventType } from "@openwork-ee/den-db/schema"

/** Server-side event-type allowlist. Lives outside contracts.ts so the
 * client-safe `./contracts` subpath never imports den-db. */

const eventTypeSet = new Set<string>(TelemetryEventType)

export function isKnownTelemetryEventType(type: string): boolean {
  return eventTypeSet.has(type)
}
