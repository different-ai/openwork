import type { TelemetryAnalyticsResponse } from "@openwork-ee/telemetry-contracts";

type AnalyticsActivity = Pick<TelemetryAnalyticsResponse,
  "activeMembers30d" | "sessions30d" | "tasksCompleted30d" | "tasksFailed30d" | "weekly">;

export function analyticsHasActivity(data: AnalyticsActivity): boolean {
  return data.activeMembers30d > 0 || data.sessions30d > 0
    || data.tasksCompleted30d + data.tasksFailed30d > 0
    || data.weekly.some((week) => week.activeMembers > 0 || week.sessions > 0);
}
