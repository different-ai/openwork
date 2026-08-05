import type { ExternalMcpToolPolicy } from "@micx-ee/den-db"

export type ToolPolicyDecision = {
  blocked: boolean
  reason?: "tool_disabled" | "all_disabled"
  disabledBy?: string
  disabledAt?: string
}

export function evaluateToolPolicy(
  policy: ExternalMcpToolPolicy | null | undefined,
  toolName: string,
): ToolPolicyDecision {
  if (!policy) return { blocked: false }

  const attribution = {
    ...(policy.updatedByName ? { disabledBy: policy.updatedByName } : {}),
    ...(policy.updatedAt ? { disabledAt: policy.updatedAt } : {}),
  }
  if (policy.allDisabled) {
    return { blocked: true, reason: "all_disabled", ...attribution }
  }
  if (policy.disabledTools.includes(toolName)) {
    return { blocked: true, reason: "tool_disabled", ...attribution }
  }
  return { blocked: false }
}

export function isToolDisabled(
  policy: ExternalMcpToolPolicy | null | undefined,
  toolName: string,
): boolean {
  return evaluateToolPolicy(policy, toolName).blocked
}
