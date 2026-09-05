import type { AutomationExecutionThread } from "@openwork/types/automations"
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes"

export type AutomationExecutionIdentity = {
  icon: "desktop" | "cloud"
  label: "Desktop" | "OpenWork Cloud"
}

export function automationExecutionIdentity(
  thread: Pick<AutomationExecutionThread, "executionLocation">,
): AutomationExecutionIdentity {
  return thread.executionLocation === "cloud"
    ? { icon: "cloud", label: "OpenWork Cloud" }
    : { icon: "desktop", label: "Desktop" }
}

export function automationExecutionThreadRoute(
  thread: Pick<AutomationExecutionThread, "id" | "automationId" | "automationRunId">,
) {
  const query = new URLSearchParams({
    automation: thread.automationId,
    run: thread.automationRunId,
    thread: thread.id,
  })
  return `/automations?${query.toString()}`
}

export function automationLocalSessionRoute(
  thread: Pick<AutomationExecutionThread, "executionLocation" | "nativeThreadId" | "workspaceId">,
) {
  if (thread.executionLocation !== "desktop") return null
  const sessionId = thread.nativeThreadId?.trim()
  const workspaceId = thread.workspaceId?.trim()
  return sessionId && workspaceId ? workspaceSessionRoute(workspaceId, sessionId) : null
}
