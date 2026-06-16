import { env } from "./env.js"
import { listScimProviders, reconcileOrganizationScimDrift, retryPendingScimSyncEvents } from "./scim.js"

let scimMaintenanceRunning = false

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
    void runScimMaintenanceOnce()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[scim][maintenance_failed] reason=${message}`)
      })
      .finally(() => {
        scimMaintenanceRunning = false
      })
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return () => clearInterval(timer)
}
