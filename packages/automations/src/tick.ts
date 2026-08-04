import type { Automation } from "@openwork/types/automations"
import type { AutomationListItem } from "./ports.js"

export function selectDueAutomations(
  candidates: readonly AutomationListItem[],
  input: { now: number; limit: number },
): AutomationListItem[] {
  const limit = Math.max(1, Math.min(Math.floor(input.limit), 500))
  return candidates
    .filter(({ automation }) => automation.state === "active" && automation.nextDueAt !== null && automation.nextDueAt <= input.now)
    .sort((left, right) =>
      (left.automation.nextDueAt ?? 0) - (right.automation.nextDueAt ?? 0)
      || left.automation.id.localeCompare(right.automation.id))
    .slice(0, limit)
}

export function hasActiveRun(runs: readonly { status: string }[]): boolean {
  return runs.some(({ status }) => status === "claimed" || status === "running")
}

export function nextAutomationAfterClaim(automation: Automation, nextDueAt: number | null, now: number): Automation {
  return { ...automation, nextDueAt, latestRunAt: now, updatedAt: now }
}
