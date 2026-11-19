import { automationTimestampFromText } from "@openwork/types/automation-schedule";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Models often write a one-time run as a date string; the schedule stores epoch milliseconds. */
export function withOnceTimestamp(rawArgs: unknown): unknown {
  if (!isRecord(rawArgs) || !isRecord(rawArgs.schedule)) return rawArgs;
  const { kind, at, timezone } = rawArgs.schedule;
  if (kind !== "once" || typeof at !== "string" || typeof timezone !== "string") return rawArgs;
  const timestamp = automationTimestampFromText(at, timezone);
  return timestamp === null ? rawArgs : { ...rawArgs, schedule: { ...rawArgs.schedule, at: timestamp } };
}
