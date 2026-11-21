import type { AutomationExecutionTarget, AutomationExecutionTargetList } from "@openwork/types/automations"

export function automationPlacementChoices(input: {
  targets: AutomationExecutionTargetList | null | undefined
  desktopRuntime: boolean
  desktopAllowed?: boolean
}): AutomationExecutionTarget[] {
  if (!input.targets) return []
  const choices: AutomationExecutionTarget[] = []
  if (input.desktopAllowed !== false && (input.desktopRuntime || input.targets.items.some((item) => item.kind === "desktop"))) choices.push("desktop")
  if (input.targets.items.some((item) => item.kind === "cloud" && item.available)) choices.push("cloud")
  return choices
}

export function resolveAutomationPlacement(
  preferred: AutomationExecutionTarget,
  choices: readonly AutomationExecutionTarget[],
): AutomationExecutionTarget {
  return choices.length === 0 || choices.includes(preferred) ? preferred : choices[0]
}

export function automationCloudOptions(targets: AutomationExecutionTargetList | null | undefined): { cloudComputer: boolean; accountsOnly: boolean } | undefined {
  if (!targets) return undefined
  for (const item of targets.items) {
    if (item.kind === "cloud" && item.available) {
      return { cloudComputer: item.cloudComputer, accountsOnly: item.runtime === "headless" }
    }
  }
  return { cloudComputer: false, accountsOnly: false }
}

export function automationCloudRunAvailable(targets: AutomationExecutionTargetList | null | undefined) {
  return targets?.items.some((item) => item.kind === "cloud" && item.available) === true
}
