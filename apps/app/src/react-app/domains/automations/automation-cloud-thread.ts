import type { AutomationExecutionThread } from "@openwork/types/automations"

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
