import { TelemetryEventType } from "@openwork-ee/den-db/schema"

const eventTypeSet = new Set<string>(TelemetryEventType)

export function isKnownTelemetryEventType(type: string): boolean {
  return eventTypeSet.has(type)
}
