import { z } from "zod"
import { organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"

export const deploymentCapabilitiesSchema = z.object({
  version: z.literal(1),
  aiGateway: z.boolean(),
  serviceReadiness: organizationServiceReadinessSchema.optional().catch(undefined),
})

export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>

export function parseDeploymentCapabilities(value: unknown): DeploymentCapabilities {
  const parsed = deploymentCapabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : { version: 1, aiGateway: false }
}
