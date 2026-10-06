import { appLogger } from "../../observability/logger.js"
import { captureException } from "../../observability/runtime.js"
import { createCoreHookRegistry } from "./registry.js"

// The process-wide registry. Registrations happen at module load (legacy/*)
// and, after W0-04, when module manifests load; the first dispatch or
// freezeCoreHooks() closes registration.
export const coreHooks = createCoreHookRegistry({
  logger: appLogger.child({ component: "core_hooks" }),
  reportError: (error, fields) => captureException(error, fields),
})

export function freezeCoreHooks() {
  coreHooks.freeze()
}

export function describeCoreHooks() {
  return coreHooks.describe()
}

export function describeCoreSecurityHooks() {
  return coreHooks.describeSecurity()
}
