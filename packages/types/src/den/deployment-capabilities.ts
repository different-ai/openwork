import { z } from "zod"
import { organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"

export const deploymentCapabilitiesSchema = z.object({
  version: z.literal(1),
  aiGateway: z.boolean(),
  // Optional to preserve version-1 responses from older servers. Diagnostics
  // are not an authorization grant and never change the configured capability.
  serviceReadiness: organizationServiceReadinessSchema.optional().catch(undefined),
})

export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>

// Parse the top-level deploymentCapabilities value, not organization metadata.
export function parseDeploymentCapabilities(value: unknown): DeploymentCapabilities {
  const parsed = deploymentCapabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : { version: 1, aiGateway: false }
}
