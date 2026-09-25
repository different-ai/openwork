import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { assertOrganizationManagedModelsAllowed } from "../../organization-metadata.js"
import { allowFreeInferenceOffer, getInferenceStatus, setInferenceEnabled, getMemberInferenceAccess, ensureMemberFreeInferenceCredential } from "../../inference.js"
import { INFERENCE_ACCESS_REASONS } from "@openwork/types/den/inference"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import { organizationHasActiveInferenceSubscription } from "../../stripe-billing.js"
import { jsonValidator, orgRoleRoute, orgMemberRoute } from "../../middleware/index.js"
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

const freeAccessSchema = z.object({
  access: z.object({ kind: z.enum(["free", "paid", "exhausted", "unavailable"]), modelID: z.string().nullable(),
    weeklyLimitUsd: z.number().nullable(), usedUsd: z.number().nullable(), reservedUsd: z.number().nullable(),
    remainingUsd: z.number().nullable(), resetsAt: z.string().datetime().nullable(), reason: z.enum(INFERENCE_ACCESS_REASONS).nullable(),
    canUpgrade: z.literal(false), catalog: z.array(z.object({ modelID: z.string(), displayName: z.string(), providerName: z.string(),
      summary: z.string(), recommended: z.boolean(), rank: z.number(), capabilities: z.array(z.string()) })).optional() }),
}).meta({ ref: "InferenceAccessResponse" })
const freeCredentialSchema = z.object({ credential: z.object({ apiKey: z.string(), baseURL: z.string(), statusURL: z.string(), modelID: z.string() }) })

export function registerOrgInferenceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/inference/access", describeRoute({ tags: ["Inference"], summary: "Get my free Auto allowance",
    description: "Returns the authenticated joined member's person-wide weekly Auto allowance without credentials.",
    responses: { 200: jsonResponse("Auto allowance returned.", freeAccessSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Active membership required.", forbiddenSchema) },
  }), orgMemberRoute(), async (c) => {
    const context = c.get("organizationContext")
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized" }, 401)
    c.header("Cache-Control", "no-store")
    const access = await getMemberInferenceAccess({ organizationId: context.organization.id, memberId: context.currentMember.id,
      userId: normalizeDenTypeId("user", user.id) })
    return c.json({ access })
  })
  app.post("/v1/inference/free/credential", describeRoute({ tags: ["Inference"], summary: "Get my free Auto credential",
    description: "Issues or reuses the member's OpenWork Models key for an organization without a Models subscription. Until the organization subscribes, the Gateway serves only free Auto on it, within the member's weekly allowance. Subscribed organizations and admin opt-outs are refused.",
    responses: { 200: jsonResponse("Member Auto credential returned.", freeCredentialSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Auto access denied.", forbiddenSchema),
      503: jsonResponse("Auto unavailable.", z.object({ error: z.string() })) },
  }), orgMemberRoute(), async (c) => {
    const context = c.get("organizationContext")
    const user = c.get("user")
    if (!user) return c.json({ error: "unauthorized" }, 401)
    c.header("Cache-Control", "no-store")
    if (!env.inferenceFree.enabled) return c.json({ error: "free_disabled" }, 503)
    try {
      const credential = await ensureMemberFreeInferenceCredential({ organizationId: context.organization.id, memberId: context.currentMember.id,
        userId: normalizeDenTypeId("user", user.id) })
      return credential ? c.json({ credential }) : c.json({ error: "forbidden" }, 403)
    } catch (error) {
      if (error instanceof ManagedModelsPolicyError) return c.json({ error: error.code, message: error.message }, error.status)
      return c.json({ error: "free_accounting_unavailable" }, 503)
    }
  })

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
            await allowFreeInferenceOffer(payload.organization.id)
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
          source: "admin",
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
