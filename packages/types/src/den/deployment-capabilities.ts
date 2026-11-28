import { z } from "zod"
import { deploymentCapabilityStatusListSchema } from "@openwork/managed-deployments/capability-state"
import { organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"

export const deploymentCapabilitiesSchema = z.object({
  version: z.literal(1),
  aiGateway: z.boolean(),
  serviceReadiness: organizationServiceReadinessSchema.optional().catch(undefined),
  capabilities: deploymentCapabilityStatusListSchema.optional().catch(undefined).meta({
    description: "What this deployment can do, one entry per capability: on, off, needs_infrastructure or unsupported, with a fixed reason code. Derived from Den's own settings, not from a live check. Older servers omit it.",
  }),
})

export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>

export function parseDeploymentCapabilities(value: unknown): DeploymentCapabilities {
  const parsed = deploymentCapabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : { version: 1, aiGateway: false }
}
