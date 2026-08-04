import type { AutomationRunStatus, AutomationState } from "@openwork/types/automations"

const transitions: Readonly<Record<AutomationState, readonly AutomationState[]>> = {
  active: ["inactive", "needs_attention", "archived"],
  inactive: ["active", "needs_attention", "archived"],
  needs_attention: ["active", "inactive", "archived"],
  archived: [],
}

const terminalRunStatuses = new Set<AutomationRunStatus>([
  "succeeded", "failed", "cancelled", "skipped",
])

export function canTransitionAutomation(from: AutomationState, to: AutomationState): boolean {
  return from === to || transitions[from].includes(to)
}

export function assertAutomationTransition(from: AutomationState, to: AutomationState): void {
  if (!canTransitionAutomation(from, to)) throw new Error(`Invalid Automation transition: ${from} -> ${to}`)
}

export function isTerminalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return terminalRunStatuses.has(status)
}
