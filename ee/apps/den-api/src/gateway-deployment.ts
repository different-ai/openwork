import { parseDeploymentCapabilities } from "@openwork/types/den/deployment-capabilities"
import { z } from "zod"
import { env } from "./env.js"

export const gatewayManagementUnavailableSchema = z.object({
  error: z.literal("gateway_not_enabled"),
  message: z.string(),
})

export function deploymentCapabilities() {
  return parseDeploymentCapabilities({ version: 1, aiGateway: env.gatewayEnabled })
}

export function gatewayManagementUnavailable(): z.infer<typeof gatewayManagementUnavailableSchema> | null {
  return env.gatewayEnabled ? null : {
    error: "gateway_not_enabled",
    message: "Gateway management is not enabled on this deployment. Ask your administrator to configure GATEWAY_ENABLED=true.",
  }
}
