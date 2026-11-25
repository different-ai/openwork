import type { FeatureOverrides } from "@openwork/features"
import type { DeploymentCapabilityStatus } from "@openwork/managed-deployments/capability-state"
import { installationVersionSchema, type InstallationConfig } from "@openwork/types/den/diagnostics"

const RELEASE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?(?:\+[0-9A-Za-z.]{1,32})?$/

export function releaseVersion(value: string | undefined): string | undefined {
  const version = value?.trim().replace(/^v(?=\d)/, "")
  return version && RELEASE_VERSION.test(version) ? version : undefined
}

export function runningAppVersion(serviceVersion: string): string {
  const version = serviceVersion.trim()
  const reported = releaseVersion(version) ?? version
  return installationVersionSchema.safeParse(reported).success ? reported : "unknown"
}

function booleanLocksByFeatureKey(locks: FeatureOverrides): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(locks)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function installationConfig(input: {
  serviceVersion: string
  helmChartVersion: string | undefined
  helmAppVersion: string | undefined
  capabilities: readonly DeploymentCapabilityStatus[]
  locks: FeatureOverrides
}): InstallationConfig {
  const appVersion = runningAppVersion(input.serviceVersion)
  const helmChartVersion = releaseVersion(input.helmChartVersion)
  const helmAppVersion = releaseVersion(input.helmAppVersion)
  return {
    appVersion,
    ...(helmChartVersion ? { helmChartVersion } : {}),
    ...(helmAppVersion ? { helmAppVersion } : {}),
    versionSkew: helmAppVersion !== undefined && helmAppVersion !== appVersion,
    deploymentCapabilities: input.capabilities.map(({ id, state, reason }) => ({ id, state, reason })),
    lockedFeatures: booleanLocksByFeatureKey(input.locks),
  }
}
