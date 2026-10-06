import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { updateOrganizationMetadata } from "../organization-metadata.js"
import { getMemberInferenceAccess, issueMemberFreeInferenceCredential, getFreeInferenceProviderSummary } from "./service.js"
import { INFERENCE_ACCESS_REASONS, freeInferenceProviderSummarySchema, withFreeInferenceDefaultPinned, freeInferenceDefaultPinned } from "@openwork/types/den/inference"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import { jsonValidator, orgMemberRoute } from "../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../openapi.js"
import type { OrgRouteVariables } from "../routes/org/shared.js"
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, orgAccessFailureStatus } from "../routes/org/shared.js"

const managedModelsPolicyErrorSchema = z.object({
  error: z.enum(["managed_models_disabled_for_dpa", "managed_models_policy_unavailable"]),
  message: z.string(),
})

const freeAccessSchema = z.object({
  access: z.object({ kind: z.enum(["free", "paid", "exhausted", "unavailable"]), modelID: z.string().nullable(),
    weeklyLimitUsd: z.number().nullable(), usedUsd: z.number().nullable(),
    remainingUsd: z.number().nullable(), resetsAt: z.string().datetime().nullable(), reason: z.enum(INFERENCE_ACCESS_REASONS).nullable(),
    defaultPinned: z.boolean().optional().describe("Organization-managed Auto pin for this membership. False removes only the organization pin; model access and personal pins are unchanged. Pins never grant access."), canUpgrade: z.literal(false), catalog: z.array(z.object({ modelID: z.string(), displayName: z.string(), providerName: z.string(),
      summary: z.string(), recommended: z.boolean(), rank: z.number(), capabilities: z.array(z.string()) })).optional() }),
}).meta({ ref: "InferenceAccessResponse" })
const freeCredentialSchema = z.object({ credential: z.object({ apiKey: z.string(), baseURL: z.string(), statusURL: z.string(), modelID: z.string() }) })

export function registerFreeInferenceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/inference/free/provider", describeRoute({ tags: ["Inference"], summary: "Get organization Free provider summary",
    description: "Admins only. Returns the organization's Auto pin policy, joined-member allowance counts and recorded free usage attributed to this organization. Allowances are person-wide; usage totals exclude other organizations, anonymous devices and paid inference. No individual balances or identities are returned.",
    responses: { 200: jsonResponse("Free provider summary returned.", z.object({ provider: freeInferenceProviderSummarySchema })),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Workspace admin permission required.", forbiddenSchema),
      503: jsonResponse("Free provider summary unavailable.", z.object({ error: z.string() })) },
  }), orgMemberRoute(), async (c) => {
    const permission = ensureOrganizationAdminRole(c, "Only workspace owners and admins can read organization allowance summaries.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    c.header("Cache-Control", "no-store")
    try { return c.json({ provider: await getFreeInferenceProviderSummary(c.get("organizationContext").organization.id) }) }
    catch { return c.json({ error: "free_provider_summary_unavailable" }, 503) }
  })
  app.patch("/v1/inference/free/pins", describeRoute({ tags: ["Inference"], summary: "Set the organization Auto pin",
    description: "A fresh owner/admin session may change only defaultPinned. Unpinning changes picker curation, not free model availability or personal pins. The atomic metadata update preserves DPA, offerAllowed and all unrelated organization configuration.",
    responses: { 200: jsonResponse("Auto pin saved.", z.object({ defaultPinned: z.boolean() })),
      400: jsonResponse("Provide only defaultPinned.", invalidRequestSchema), 401: jsonResponse("Authentication required.", unauthorizedSchema),
      403: jsonResponse("Fresh workspace admin permission required.", forbiddenSchema),
      503: jsonResponse("Organization policy unavailable.", managedModelsPolicyErrorSchema) },
  }), orgMemberRoute(), jsonValidator(z.strictObject({ defaultPinned: z.boolean() })), async (c) => {
    const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can change the Auto pin.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    c.header("Cache-Control", "no-store")
    const { defaultPinned } = c.req.valid("json")
    try {
      const metadata = await updateOrganizationMetadata(c.get("organizationContext").organization.id, (current) => withFreeInferenceDefaultPinned(current, defaultPinned))
      return c.json({ defaultPinned: freeInferenceDefaultPinned(metadata) })
    } catch (error) {
      if (error instanceof ManagedModelsPolicyError) return c.json({ error: error.code, message: error.message }, error.status)
      throw error
    }
  })
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
  const FREE_REFUSAL_MESSAGES = {
    free_not_offered: "Your organization has turned off Auto.",
    not_eligible: "Auto isn't available for this account.",
  } as const
  app.post("/v1/inference/free/credential", describeRoute({ tags: ["Inference"], summary: "Get my free Auto credential",
    description: "Issues or reuses the member's OpenWork Models key for free Auto, within the member's weekly allowance. Organizations with an OpenWork Models subscription get it too; Auto is never billed to them. A refusal names its reason: free_not_offered (the organization turned the free starter model off) or not_eligible.",
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
      const result = await issueMemberFreeInferenceCredential({ organizationId: context.organization.id, memberId: context.currentMember.id,
        userId: normalizeDenTypeId("user", user.id) })
      if ("credential" in result) return c.json({ credential: result.credential })
      if (result.refusal === "free_disabled") return c.json({ error: "free_disabled" }, 503)
      return c.json({ error: result.refusal, message: FREE_REFUSAL_MESSAGES[result.refusal] }, 403)
    } catch (error) {
      if (error instanceof ManagedModelsPolicyError) return c.json({ error: error.code, message: error.message }, error.status)
      return c.json({ error: "free_accounting_unavailable" }, 503)
    }
  })
}
