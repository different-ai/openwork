import { installedDeploymentCapabilityStates, type DeploymentCapabilityStatus } from "@openwork/managed-deployments/capability-state"
import { env } from "./env.js"
import { configuredDeploymentServices } from "./service-readiness-runtime.js"

export function deploymentCapabilityStates(): DeploymentCapabilityStatus[] {
  const configured = configuredDeploymentServices()
  return installedDeploymentCapabilityStates({
    headlessRunnerConfigured: configured.has("headlessRunner"),
    workbotConfigured: configured.has("workbot"),
    gatewayEnabled: env.gatewayEnabled,
    gatewayAddressConfigured: Boolean(env.gatewayProxyBaseUrl),
    automationsEnabled: env.automations.enabled,
    slackAssistantWorkerEnabled: process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED !== "false",
  })
}
