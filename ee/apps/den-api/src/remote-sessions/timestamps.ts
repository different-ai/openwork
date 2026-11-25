import { RUNNER_SESSION_TIMESTAMP_MAX } from "@openwork/types/automations"

export function sessionTimestampIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > RUNNER_SESSION_TIMESTAMP_MAX) return null
  return new Date(value).toISOString()
}
