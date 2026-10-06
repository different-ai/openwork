import {
  createConsoleModuleLogger,
  createModuleRuntime,
  describeDeployment,
  parseInstanceConfig,
  unavailableModules,
  type InstanceConfig,
  type ModuleId,
} from "@openwork-ee/den-modules"
import { db } from "../db.js"
import { env, isDevMode } from "../env.js"

/**
 * The modules the gateway can judge on its own. Everything else is reported
 * available here: den-api owns those, and the gateway never gates on them.
 */
export const GATEWAY_OBSERVABLE_MODULES: readonly ModuleId[] = [
  "aiGateway",
  "aiGateway.usageLimits",
  "openworkModels",
  "openworkModels.analytics",
  "freeInference",
  "billing",
]

const logger = createConsoleModuleLogger()

/**
 * Den-only flags (audit, automations, org mode) never affect the modules the
 * gateway observes, so a value only den-api would reject is logged here
 * instead of stopping the gateway.
 */
function sharedInstanceConfig(): InstanceConfig {
  try {
    return parseInstanceConfig(process.env)
  } catch (error) {
    logger.warn("den_modules_instance_config_invalid", { service: "gateway", error: error instanceof Error ? error.message : String(error) })
    return parseInstanceConfig({})
  }
}

const parsed = sharedInstanceConfig()
// The gateway's own parsed values win over the shared parser.
const instance: InstanceConfig = {
  ...parsed,
  infra: { ...parsed.infra, gatewayEnabled: env.gatewayEnabled, freeInferenceConfigured: env.freeAuto.member.enabled },
}
const { deployment, source } = describeDeployment({ DEN_DEPLOYMENT: env.deployment }, instance.orgMode)

/**
 * The gateway's module runtime (plan W0-03). Constructed at boot and unused
 * until W0-06 adds enforcement. Org rows are cached for 60 s by the org
 * context middleware, so a toggle can take up to a minute here (R8).
 */
export const gatewayModuleRuntime = createModuleRuntime({
  deployment,
  instance,
  availabilityObservable: GATEWAY_OBSERVABLE_MODULES,
  database: db,
  memo: { maxEntries: 5_000 },
  shadow: { enabled: false },
  logger,
  isProduction: !isDevMode,
})

logger.info("den_modules_deployment", {
  service: "gateway",
  deployment,
  source,
  unavailable: unavailableModules(gatewayModuleRuntime.availability),
})
