import { z } from "zod"

const suffix = "[0-7][0-9a-hjkmnp-tv-z]{25}"
export const gatewayRouterRouteSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1000),
  inferenceProviderId: z.string().regex(new RegExp(`^ipr_${suffix}$`)),
  model: z.string().regex(new RegExp(`^gwm_${suffix}_${suffix}_${suffix}$`)),
}).strict()

export const gatewayRouterDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  status: z.enum(["active", "disabled"]),
  routes: z.array(gatewayRouterRouteSchema).min(2).max(12),
  fallbackRouteId: gatewayRouterRouteSchema.shape.id,
  minConfidence: z.number().min(0).max(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.routes.map((route) => route.id)).size !== value.routes.length) {
    ctx.addIssue({ code: "custom", path: ["routes"], message: "Route IDs must be unique." })
  }
  if (!value.routes.some((route) => route.id === value.fallbackRouteId)) {
    ctx.addIssue({ code: "custom", path: ["fallbackRouteId"], message: "Fallback must reference a route." })
  }
})
export const gatewayRouterUpdateSchema = gatewayRouterDefinitionSchema.safeExtend({ revision: z.number().int().min(1).max(2147483646) })
export const gatewayRouterSummarySchema = gatewayRouterDefinitionSchema.safeExtend({
  id: z.string().regex(new RegExp(`^gwr_${suffix}$`)),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export const gatewayRouterTargetSchema = z.object({
  inferenceProviderId: gatewayRouterRouteSchema.shape.inferenceProviderId,
  model: gatewayRouterRouteSchema.shape.model,
  name: z.string(),
  providerName: z.string(),
})
export type GatewayRouterDefinition = z.infer<typeof gatewayRouterDefinitionSchema>
export type GatewayRouterSummary = z.infer<typeof gatewayRouterSummarySchema>
export type GatewayRouterTarget = z.infer<typeof gatewayRouterTargetSchema>
export type GatewayRouterConfiguration = Pick<GatewayRouterDefinition, "routes" | "fallbackRouteId" | "minConfidence">

/** Only SDKs served by the gateway's OpenAI-compatible protocol adapter. */
export function isGatewayRouterTargetNpm(npm: string | null): boolean {
  return npm !== null && ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/azure", "@openrouter/ai-sdk-provider"].includes(npm)
}
