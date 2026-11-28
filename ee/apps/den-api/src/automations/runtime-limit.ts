import type { AutomationAction, AutomationExecutionTarget } from "@openwork/types/automations"

export function requireCloudAgentRuntime(target: AutomationExecutionTarget, action: AutomationAction | undefined) {
  if (target !== "cloud" || action?.kind !== "agent") throw new Error("automation_runtime_cloud_agent_only")
}
