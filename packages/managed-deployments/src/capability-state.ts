import { z } from "zod"
import { capability, CUSTOMER_CAPABILITY_IDS, requiredRolloutFlags, type CustomerCapabilityId, type ManagedDeploymentTarget } from "@openwork/managed-deployments/capabilities"
import type { AwsTarget } from "@openwork/managed-deployments/schema"

/**
 * `on`: set up on this deployment. `off`: the deployment could run it, and a switch keeps it off.
 * `needs_infrastructure`: turning it on first installs something in the customer's cloud.
 * `unsupported`: this kind of deployment cannot have it.
 */
export const capabilityStateSchema = z.enum(["on", "off", "needs_infrastructure", "unsupported"])
export type CapabilityState = z.infer<typeof capabilityStateSchema>

/** Fixed codes, never values. */
export const capabilityStateReasonSchema = z.enum([
  "configured", "configured_on_runner", "needs_rollout_flag",
  "switched_off", "rollout_flag_off",
  "service_not_installed", "dependency_not_installed",
  "not_offered",
])
export type CapabilityStateReason = z.infer<typeof capabilityStateReasonSchema>

export const deploymentCapabilityStatusSchema = z.object({
  id: z.enum(CUSTOMER_CAPABILITY_IDS),
  state: capabilityStateSchema,
  reason: capabilityStateReasonSchema,
}).meta({ ref: "DeploymentCapabilityStatus" })
export type DeploymentCapabilityStatus = z.infer<typeof deploymentCapabilityStatusSchema>

export const deploymentCapabilityStatusListSchema = z.array(deploymentCapabilityStatusSchema).max(CUSTOMER_CAPABILITY_IDS.length)

export const managedDeploymentCapabilitiesSchema = z.object({
  deploymentId: z.string().uuid(),
  target: z.enum(["managed-aws", "managed-gcp"]),
  capabilities: deploymentCapabilityStatusListSchema,
}).meta({ ref: "ManagedDeploymentCapabilities" })
export type ManagedDeploymentCapabilities = z.infer<typeof managedDeploymentCapabilitiesSchema>

export const CAPABILITY_STATE_LABELS: Record<CapabilityState, string> = {
  on: "On", off: "Off", needs_infrastructure: "Needs installation", unsupported: "Not available",
}
export const CAPABILITY_STATE_REASON_LABELS: Record<CapabilityStateReason, string> = {
  configured: "Set up on this deployment.",
  configured_on_runner: "The runner is installed. Its computer provider is set on the runner and is not reported here.",
  needs_rollout_flag: "A computer provider is chosen. Members see computers only once the remote computers feature is on in the installed OpenWork.",
  switched_off: "Installed, and turned off in the deployment's settings.",
  rollout_flag_off: "Installed, and waiting for a feature that is off for this workspace.",
  service_not_installed: "Its service is not installed in this deployment yet.",
  dependency_not_installed: "It needs the headless runner, which is not installed in this deployment yet.",
  not_offered: "This kind of deployment cannot have it yet.",
}

type Status = Pick<DeploymentCapabilityStatus, "state" | "reason">
const ON: Status = { state: "on", reason: "configured" }
const OFF: Status = { state: "off", reason: "switched_off" }
const NOT_OFFERED: Status = { state: "unsupported", reason: "not_offered" }
const NO_SERVICE: Status = { state: "needs_infrastructure", reason: "service_not_installed" }
const NO_RUNNER: Status = { state: "needs_infrastructure", reason: "dependency_not_installed" }

/** The signals a running Den already has about itself: service settings, its own switches and its features. */
export type InstalledDeploymentSignals = {
  headlessRunnerConfigured: boolean
  workbotConfigured: boolean
  gatewayEnabled: boolean
  gatewayAddressConfigured: boolean
  automationsEnabled: boolean
  slackAssistantWorkerEnabled: boolean
  requiredComputerFlagsOn: boolean
}

function installedStatus(id: CustomerCapabilityId, signals: InstalledDeploymentSignals): Status {
  switch (id) {
    case "aiGateway": return signals.gatewayEnabled ? ON : signals.gatewayAddressConfigured ? OFF : NO_SERVICE
    case "automations": return signals.automationsEnabled ? ON : OFF
    case "workbot": return !signals.headlessRunnerConfigured ? NO_RUNNER : signals.workbotConfigured ? ON : NO_SERVICE
    case "slackAssistant": return !signals.headlessRunnerConfigured ? NO_RUNNER : signals.slackAssistantWorkerEnabled ? ON : OFF
    case "cloudComputers":
      if (!signals.headlessRunnerConfigured) return NO_RUNNER
      return signals.requiredComputerFlagsOn ? { state: "on", reason: "configured_on_runner" } : { state: "off", reason: "rollout_flag_off" }
  }
}

/** A running Den does not know which installer made it, so it never reports `unsupported`. */
export function installedDeploymentCapabilityStates(signals: InstalledDeploymentSignals): DeploymentCapabilityStatus[] {
  return CUSTOMER_CAPABILITY_IDS.map((id) => ({ id, ...installedStatus(id, signals) }))
}

function managedAwsStatus(id: CustomerCapabilityId, target: AwsTarget): Status {
  const gateway = target.runtimeProfile === "gateway"
  const assistants = target.assistants
  const runner = gateway || assistants.headlessRunnerEnabled
  switch (id) {
    case "automations": return ON
    case "aiGateway": return gateway ? ON : NO_SERVICE
    case "workbot": return !runner ? NO_RUNNER : gateway || assistants.workbotEnabled ? ON : NO_SERVICE
    case "slackAssistant": return !runner ? NO_RUNNER : gateway || assistants.slackAssistantEnabled ? ON : OFF
    case "cloudComputers":
      if (!runner) return NO_RUNNER
      if (assistants.computerProvider === "off") return NO_SERVICE
      return requiredRolloutFlags(id, "managed-aws").length ? { state: "on", reason: "needs_rollout_flag" } : ON
  }
}

/** What a managed deployment is recorded to have. OpenWork Cloud computes it from the target alone. */
export function managedDeploymentCapabilityStates(deployment: { provider: "aws"; target: AwsTarget } | { provider: "gcp" }): { target: ManagedDeploymentTarget; capabilities: DeploymentCapabilityStatus[] } {
  const target: ManagedDeploymentTarget = deployment.provider === "aws" ? "managed-aws" : "managed-gcp"
  return {
    target,
    capabilities: CUSTOMER_CAPABILITY_IDS.map((id) => {
      if (capability(id).targets[target].support === "unsupported" || deployment.provider !== "aws") return { id, ...NOT_OFFERED }
      return { id, ...managedAwsStatus(id, deployment.target) }
    }),
  }
}
