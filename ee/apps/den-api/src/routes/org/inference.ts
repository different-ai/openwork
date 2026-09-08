import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { INFERENCE_ACCESS_REASONS } from "@openwork/types/den/inference"
import { getInferenceStatus, getMemberInferenceAccess, repairMemberInferenceAccessIfNeeded, setInferenceEnabled } from "../../inference.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { organizationHasActiveInferenceSubscription } from "../../stripe-billing.js"
import { jsonValidator, orgMemberRoute, orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, orgAccessFailureStatus } from "./shared.js"

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

const managedModelRecommendationSchema = z.object({
  modelID: z.string(),
  displayName: z.string(),
  providerName: z.string(),
  summary: z.string(),
  recommended: z.boolean(),
  rank: z.number(),
  capabilities: z.array(z.string()),
}).meta({ ref: "ManagedModelRecommendation" })

const inferenceAccessResponseSchema = z.object({
  access: z.object({
    kind: z.enum(["paid", "free", "exhausted", "unavailable"]),
    modelID: z.string().nullable(),
    weeklyLimitUsd: z.number().nullable(),
    usedUsd: z.number().nullable(),
    reservedUsd: z.number().nullable(),
    remainingUsd: z.number().nullable(),
    resetsAt: z.string().nullable(),
    reason: z.enum(INFERENCE_ACCESS_REASONS).nullable(),
    canUpgrade: z.boolean(),
    catalog: z.array(managedModelRecommendationSchema).optional(),
    plan: z.object({
      name: z.string(),
      priceLabel: z.string().nullable(),
      usageLabel: z.string(),
    }).optional(),
  }),
  upgradePath: z.literal("/dashboard/billing").nullable(),
}).meta({ ref: "InferenceAccessResponse" })

export function registerOrgInferenceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/inference/access",
    describeRoute({
      tags: ["Inference"],
      summary: "Get my managed inference access",
      description: "Returns the signed-in joined member's access and person-wide weekly free allowance, without credentials or administrative settings. The catalog describes registered, enabled managed aliases for discovery only; clients must intersect it with their available, policy-filtered provider models. Plan allowances describe the current paid tier or the entry paid tier offered on upgrade; a null price requires review on the billing page.",
      responses: {
        200: jsonResponse("Managed inference access returned successfully.", inferenceAccessResponseSchema),
        401: jsonResponse("Sign in to read inference access.", unauthorizedSchema),
        403: jsonResponse("Join the organization before using inference.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload.currentMember.joinedAt) return c.json({ error: "forbidden" }, 403)
      const user = c.get("user")
      if (!user) return c.json({ error: "unauthorized" }, 401)
      await repairMemberInferenceAccessIfNeeded({ organizationId: payload.organization.id, memberId: payload.currentMember.id })
      const access = await getMemberInferenceAccess({
        organizationId: payload.organization.id, memberId: payload.currentMember.id, userId: normalizeDenTypeId("user", user.id),
      })
      const canUpgrade = ensureOrganizationAdminRole(c, "Only workspace owners and admins can upgrade.").ok
      c.header("Cache-Control", "no-store")
      return c.json({ access: { ...access, canUpgrade }, upgradePath: canUpgrade ? "/dashboard/billing" : null })
    },
  )

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
        403: jsonResponse("Only workspace owners and admins can update inference settings.", forbiddenSchema),
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
