import { isFeatureKey, type FeatureMap } from "@openwork/features"
import { requiredRolloutFlags } from "@openwork/managed-deployments/capabilities"
import { installedDeploymentCapabilityStates, type DeploymentCapabilityStatus } from "@openwork/managed-deployments/capability-state"
import { env } from "./env.js"
import { configuredDeploymentServices } from "./service-readiness-runtime.js"

export function deploymentCapabilityStates(features: FeatureMap): DeploymentCapabilityStatus[] {
  const configured = configuredDeploymentServices()
  return installedDeploymentCapabilityStates({
    headlessRunnerConfigured: configured.has("headlessRunner"),
    workbotConfigured: configured.has("workbot"),
    gatewayEnabled: env.gatewayEnabled,
    gatewayAddressConfigured: Boolean(env.gatewayProxyBaseUrl),
    automationsEnabled: env.automations.enabled,
    slackAssistantWorkerEnabled: process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED !== "false",
    requiredComputerFlagsOn: requiredRolloutFlags("cloudComputers").every((key) => isFeatureKey(key) && features[key]),
  })
}
