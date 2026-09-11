import { z } from "zod"

export const deploymentCapabilitiesSchema = z.object({
  version: z.literal(1),
  aiGateway: z.boolean(),
})

export type DeploymentCapabilities = z.infer<typeof deploymentCapabilitiesSchema>

// Parse the top-level deploymentCapabilities value, not organization metadata.
export function parseDeploymentCapabilities(value: unknown): DeploymentCapabilities {
  const parsed = deploymentCapabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : { version: 1, aiGateway: false }
}
