import { hostname } from "node:os"
import {
  createDisabledLicenseClient,
  createModuleRuntime,
  describeDeployment,
  unavailableModules,
  type EntitlementMode,
  type LicenseRuntimeOptions,
  type ModuleLogger,
  type OrgModuleRow,
} from "@openwork-ee/den-modules"
import { cache } from "../cache.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"
import { denApiAppVersion } from "../version.js"
import { workbotOrigin } from "../workbot/config.js"
import { cloudRuntimeAvailable } from "../workers/cloud-runtime.js"
import { instanceConfigFromDenEnv } from "./instance-config.js"

/**
 * Den's module runtime (plan W0-03). Behavior-neutral for now: nothing gates
 * on it. It resolves effective module state from the org row requests
 * already load, and shadow-compares it with today's helpers
 * (`legacy-oracles.ts`) when `DEN_MODULES_SHADOW_COMPARE` is on.
 */

const logger: ModuleLogger = {
  info: (event, fields) => appLogger.info(event, { component: "den-modules", ...fields }),
  warn: (event, fields) => appLogger.warn(event, { component: "den-modules", ...fields }),
  error: (event, fields) => appLogger.error(event, { component: "den-modules", ...fields }),
}

const ENTITLEMENT_MODES: Record<typeof env.modules.entitlementSource, EntitlementMode> = {
  legacy: "legacy",
  dev_override: "devOverride",
  license: "license",
}

const instance = instanceConfigFromDenEnv(env, {
  headlessRunnerConfigured: () => headlessRunnerConfig(process.env) !== null,
  workbotConfigured: () => workbotOrigin(process.env) !== null,
  cloudRuntimeAvailable: () => cloudRuntimeAvailable(),
})
const { deployment, source: deploymentSource } = describeDeployment({ DEN_DEPLOYMENT: env.modules.deployment }, env.orgMode)
const entitlementMode = ENTITLEMENT_MODES[env.modules.entitlementSource]

function licenseOptions(): LicenseRuntimeOptions | undefined {
  if (entitlementMode !== "license") return undefined
  return {
    // Phase 5 replaces the stub with the HTTP client and a real seat count.
    client: createDisabledLicenseClient(),
    request: { baseUrl: env.betterAuthUrl, instanceId: hostname(), version: denApiAppVersion.latestAppVersion, currentUsers: async () => 0 },
    leases: env.databaseRedisUrl ? { acquire: cache.acquireLease } : undefined,
  }
}

export const moduleRuntime = createModuleRuntime({
  deployment,
  instance,
  database: db,
  entitlementMode,
  devOverride: env.modules.licenseDevOverride,
  license: licenseOptions(),
  shadow: { enabled: env.modules.shadowCompare },
  logger,
  isProduction: !env.devMode,
})

logger.info("den_modules_deployment", {
  deployment,
  source: deploymentSource,
  orgMode: env.orgMode,
  entitlementMode,
  shadowCompare: env.modules.shadowCompare,
  unavailable: unavailableModules(moduleRuntime.availability),
})

/** Shadow-compare call sites (organization context middleware). Never throws, never awaits. */
export function shadowCompareOrganization(organization: OrgModuleRow): void {
  if (!env.modules.shadowCompare) return
  moduleRuntime.shadowCompare({ id: organization.id, metadata: organization.metadata, modules: organization.modules })
}
