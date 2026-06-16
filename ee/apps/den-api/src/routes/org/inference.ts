import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { getInferenceStatus, setInferenceEnabled } from "../../inference.js"
import { organizationHasActiveInferenceSubscription } from "../../stripe-billing.js"
import { jsonValidator, orgMemberRoute, orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner } from "./shared.js"

const inferenceSettingsSchema = z.object({
  enabled: z.boolean(),
  tier: z.enum(["tier1", "tier2"]).optional(),
})

const inferenceUsageBucketSchema = z.object({
  windowType: z.enum(["five_hour", "weekly", "monthly"]),
  windowStartAt: z.string(),
  windowEndAt: z.string(),
  limitAmount: z.number(),
  usedAmount: z.number(),
})

const inferenceStatusSchema = z.object({
  enabled: z.boolean(),
  tier: z.enum(["tier1", "tier2"]),
  memberCount: z.number(),
  proxyBaseUrl: z.string(),
  upstreamProviderConfigured: z.boolean(),
  subscribed: z.boolean().optional(),
  buckets: z.array(inferenceUsageBucketSchema),
}).meta({ ref: "InferenceStatus" })

const inferenceStatusResponseSchema = z.object({
  inference: inferenceStatusSchema,
}).meta({ ref: "InferenceStatusResponse" })

const inferenceProviderMissingSchema = z.object({
  error: z.literal("openrouter_management_api_key_missing"),
  message: z.string(),
}).meta({ ref: "InferenceProviderMissingError" })

export function registerOrgInferenceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/inference",
    describeRoute({
      tags: ["Inference"],
      summary: "Get inference settings",
      description: "Returns OpenWork Models enablement and limit context for the active organization.",
      responses: {
        200: jsonResponse("Inference settings returned successfully.", inferenceStatusResponseSchema),
        401: jsonResponse("The caller must be signed in to read inference settings.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      return c.json({
        inference: {
          ...await getInferenceStatus(payload.organization.id),
          subscribed: await organizationHasActiveInferenceSubscription(payload.organization.id),
        },
      })
    },
  )

  app.patch(
    "/v1/inference",
    describeRoute({
      tags: ["Inference"],
      summary: "Update inference settings",
      description: "Enables or disables OpenWork Models for the active organization.",
      responses: {
        200: jsonResponse("Inference settings updated successfully.", inferenceStatusResponseSchema),
        400: jsonResponse("The inference settings request was invalid.", z.union([invalidRequestSchema, inferenceProviderMissingSchema])),
        401: jsonResponse("The caller must be signed in to update inference settings.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can update inference settings.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["owner"]),
    jsonValidator(inferenceSettingsSchema),
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }

      const payload = c.get("organizationContext")
      const input = c.req.valid("json")

      if (input.enabled) {
        const subscribed = await organizationHasActiveInferenceSubscription(payload.organization.id)
        if (!subscribed) {
          return c.json({
            inference: {
              ...await getInferenceStatus(payload.organization.id),
              subscribed: false,
            },
          })
        }
      }

      try {
        const inference = await setInferenceEnabled({
          organizationId: payload.organization.id,
          enabled: input.enabled,
          tier: input.tier,
        })
        return c.json({ inference: { ...inference, subscribed: await organizationHasActiveInferenceSubscription(payload.organization.id) } })
      } catch (error) {
        if (error instanceof Error && error.message === "openrouter_management_api_key_missing") {
          return c.json({
            error: "openrouter_management_api_key_missing",
            message: "Set OPENROUTER_MANAGEMENT_API_KEY on Den API before enabling OpenWork Models.",
          }, 400)
        }
        throw error
      }
    },
  )
}
