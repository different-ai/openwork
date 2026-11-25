import type { SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store"

export type CurrentToolLifecycle = "running" | "waiting" | "interrupted"

const ACTIVE_SESSION_STATUSES = new Set<SessionActivityStatus>([
  "thinking",
  "responding",
  "compacting",
])

export function resolveCurrentToolLifecycle(
  activityStatus: SessionActivityStatus,
  isCurrentTurnTool: boolean,
  isToolInFlight: boolean,
): CurrentToolLifecycle | null {
  if (!isCurrentTurnTool || !isToolInFlight) return null
  if (activityStatus === "waiting") return "waiting"
  if (ACTIVE_SESSION_STATUSES.has(activityStatus)) return "running"
  return "interrupted"
}
