import type { AutomationExecutionTarget } from "@openwork/types/automations"

import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider"

export function useAutomationDeploymentEnabled() {
  const { config, loading } = useDesktopConfig()
  return !loading && config.automationsEnabled === true
}

export function useDesktopAutomationsEnabled() {
  const { config, loading } = useDesktopConfig()
  return !loading && config.automationsEnabled === true && config.desktopAutomationsEnabled !== false
}

export function automationCreationPlacement(): AutomationExecutionTarget {
  return isDesktopRuntime() ? "desktop" : "cloud"
}
