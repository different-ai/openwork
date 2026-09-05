import type { AutomationExecutionTarget } from "@openwork/types/automations"

import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider"

/**
 * Deployment-level Automation availability advertised by Den.
 *
 * Older Den versions and stale cached configs omit the field. Treat both as
 * disabled so self-deployed installations and startup stay fail-closed.
 */
export function useAutomationDeploymentEnabled() {
  const { config, loading } = useDesktopConfig()
  return !loading && config.automationsEnabled === true
}

/**
 * The surface that creates an Automation fixes its execution placement for
 * life: Desktop creates Desktop Automations that its signed-in runner claims;
 * every browser surface creates Cloud Automations that Den runs headlessly.
 */
export function automationCreationPlacement(): AutomationExecutionTarget {
  return isDesktopRuntime() ? "desktop" : "cloud"
}
