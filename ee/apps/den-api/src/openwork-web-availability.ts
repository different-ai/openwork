import { env } from "./env.js"
import { hasOpenWorkWebComplimentaryAccess } from "./openwork-web-access.js"

export function openWorkWebDeploymentAvailable(enabled: boolean) {
  return enabled === true
}

export function isOpenWorkWebAvailable() {
  return openWorkWebDeploymentAvailable(env.openworkWebEnabled)
}

export function openWorkWebAvailableForOrganization(
  enabled: boolean,
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return openWorkWebDeploymentAvailable(enabled) || hasOpenWorkWebComplimentaryAccess(metadata)
}

export function isOpenWorkWebAvailableForOrganization(
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return openWorkWebAvailableForOrganization(env.openworkWebEnabled, metadata)
}
