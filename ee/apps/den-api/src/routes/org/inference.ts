import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { assertOrganizationManagedModelsAllowed } from "../../organization-metadata.js"
import { getInferenceStatus, setInferenceEnabled } from "../../inference.js"
import { organizationHasActiveInferenceSubscription } from "../../stripe-billing.js"
import { jsonValidator, orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"

const inferenceSettingsSchema = z.object({
  enabled: z.boolean(),
  tier: z.enum(["tier1", "tier2"]).optional(),
})

const inferenceUsageBucketSchema = z.object({
  windowType: z.enum(["five_hour", "weekly", "monthly"]),
  windowStartAt: z.string().datetime(),
  windowEndAt: z.string().datetime(),
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

const managedModelsPolicyErrorSchema = z.object({
  error: z.enum(["managed_models_disabled_for_dpa", "managed_models_policy_unavailable"]),
  message: z.string(),
})

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
        403: jsonResponse("Only workspace owners and admins can read inference settings.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
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
        403: jsonResponse("Inference settings access is denied.", z.union([forbiddenSchema, managedModelsPolicyErrorSchema])),
        503: jsonResponse("Managed Models policy is unavailable.", managedModelsPolicyErrorSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    jsonValidator(inferenceSettingsSchema),
    async (c) => {
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can update inference settings.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const payload = c.get("organizationContext")
      const input = c.req.valid("json")

      try {
        if (input.enabled) {
          await assertOrganizationManagedModelsAllowed(payload.organization.id)
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

        const inference = await setInferenceEnabled({
          organizationId: payload.organization.id,
          enabled: input.enabled,
          tier: input.tier,
        })
        return c.json({ inference: { ...inference, subscribed: await organizationHasActiveInferenceSubscription(payload.organization.id) } })
      } catch (error) {
        if (error instanceof ManagedModelsPolicyError) {
          return c.json({ error: error.code, message: error.message }, error.status)
        }
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
