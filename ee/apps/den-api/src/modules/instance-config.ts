import type { InstanceConfig } from "@openwork-ee/den-modules"
import type { env as denEnv } from "../env.js"

type DenEnv = typeof denEnv

/**
 * Infrastructure inputs that need more than the parsed env (the headless
 * runner's URL rules, Workbot's origin rules, cloud runtime credentials).
 * `runtime.ts` passes den-api's own helpers.
 */
export type DenInfrastructureProbes = {
  headlessRunnerConfigured: () => boolean
  workbotConfigured: () => boolean
  cloudRuntimeAvailable: () => boolean
}

/**
 * The den-modules instance config from den-api's already-parsed env
 * (00-legacy-mapping I5: never re-parse process.env for flags). The gateway
 * uses `parseInstanceConfig`; a test keeps the two in step.
 */
export function instanceConfigFromDenEnv(env: DenEnv, probes: DenInfrastructureProbes): InstanceConfig {
  return {
    orgMode: env.orgMode,
    infra: {
      gatewayEnabled: env.gatewayEnabled,
      headlessRunnerConfigured: probes.headlessRunnerConfigured(),
      workbotConfigured: probes.workbotConfigured(),
      cloudRuntimeAvailable: probes.cloudRuntimeAvailable(),
      freeInferenceConfigured: env.inferenceFree.enabled,
    },
    deprecatedFlags: {
      planGatingEnabled: env.planGatingEnabled,
      automationsRuntimeEnabled: env.automations.runtimeEnabled,
      automationsDesktopEnabled: env.automations.enabled,
      appMcpServersEnabled: env.appMcpServersEnabled,
      dashboardsDesktopEnabled: env.dashboardsEnabled,
      openworkWebEnabled: env.openworkWebEnabled,
      auditCaptureEnabled: env.auditCaptureEnabled,
      auditVisibilityEnabled: env.auditVisibilityEnabled,
      auditSelfHostedEnabled: env.auditSelfHostedEnabled,
      slackAssistantWorkerEnabled: env.slackAssistantWorkerEnabled,
    },
  }
}
