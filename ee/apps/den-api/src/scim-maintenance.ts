import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { captureException } from "./observability/runtime.js"
import { SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER } from "./operational-log-markers.js"
import { listScimProviders, reconcileOrganizationScimDrift, retryPendingScimSyncEvents } from "./scim.js"

let scimMaintenanceRunning = false
let scimMaintenancePromise: Promise<void> | null = null
const logger = appLogger.child({ component: "scim_maintenance" })

export async function runScimMaintenanceOnce() {
  const retryResult = await retryPendingScimSyncEvents()
  const providers = await listScimProviders()
  let reconciled = 0
  let repaired = 0
  let failures = 0

  for (const provider of providers) {
    const result = await reconcileOrganizationScimDrift(provider.organizationId)
    reconciled += result.checked
    repaired += result.repaired
    failures += result.failures
  }

  return {
    retry: retryResult,
    reconciliation: {
      providers: providers.length,
      checked: reconciled,
      repaired,
      failures,
    },
  }
}

export function startScimMaintenanceLoop(intervalMs = env.scimMaintenanceIntervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined
  }

  const run = () => {
    if (scimMaintenanceRunning) {
      return
    }

    scimMaintenanceRunning = true
    scimMaintenancePromise = runScimMaintenanceOnce()
      .then(() => undefined)
      .catch((error) => {
        logger.error(`${SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER} scim maintenance failed`, {
          operational_marker: SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
          error,
        })
        captureException(error, { component: "scim_maintenance" })
      })
      .finally(() => {
        scimMaintenanceRunning = false
        scimMaintenancePromise = null
      })
    void scimMaintenancePromise
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await scimMaintenancePromise
  }
}
