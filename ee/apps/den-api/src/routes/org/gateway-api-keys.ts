import {
  createdGatewayApiKeySchema,
  gatewayApiKeyNameSchema,
  memberGatewayApiKeysViewSchema,
  organizationAiGatewaySettingsSchema,
  organizationGatewayApiKeysViewSchema,
  readOrganizationAiGatewaySettings,
  withOrganizationAiGatewaySettings,
  GATEWAY_API_KEY_MEMBER_LIMIT,
} from "@openwork/types/den/gateway-api-keys"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import {
  createMemberGatewayApiKey,
  gatewayApiBaseUrl,
  GatewayApiKeyLimitError,
  listMemberGatewayApiKeys,
  listOrganizationGatewayApiKeys,
  memberApiKeysAllowed,
  revokeGatewayApiKey,
} from "../../gateway-api-keys.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import type { OrgRouteVariables } from "./shared.js"

const settingsViewSchema = z.object({ settings: organizationAiGatewaySettingsSchema }).meta({ ref: "OrganizationAiGatewaySettings" })
const settingsInputSchema = organizationAiGatewaySettingsSchema.partial().strict()
  .refine((value) => value.memberApiKeys !== undefined, { message: "Provide memberApiKeys." })
  .meta({ ref: "OrganizationAiGatewaySettingsInput" })
const createInputSchema = z.object({
  name: gatewayApiKeyNameSchema,
  /** When the key stops working (ISO 8601); omit or null for a key that never expires. Must be in the future. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().meta({ ref: "CreateGatewayApiKeyRequest" })
const apiKeyParamsSchema = z.object({ apiKeyId: denTypeIdSchema("gatewayApiKey") })
const errorSchema = z.object({ error: z.string(), message: z.string() })

const unauthorized = jsonResponse("Authentication required.", unauthorizedSchema)
const notFound = jsonResponse("The organization was not found, or AI Gateway API keys are off for it.", notFoundSchema)
const keyNotFound = jsonResponse("No such active key, or AI Gateway API keys are off for the organization.", notFoundSchema)

/**
 * AI Gateway API keys for 3rd party tools (feature `gatewayMemberApiKeys`): the organization setting in
 * Settings › General, each member's own keys in Library › Models, and every key in AI Gateway › API Keys.
 */
export function registerOrgGatewayApiKeyRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/ai-gateway-settings",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Get AI Gateway settings",
      description: "Returns whether members may create their own AI Gateway API keys and use the Gateway from 3rd party tools and harnesses. Any member can read it. Needs the AI Gateway API keys feature.",
      responses: { 200: jsonResponse("AI Gateway settings returned.", settingsViewSchema), 401: unauthorized, 404: notFound },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json({ settings: readOrganizationAiGatewaySettings(c.get("organizationContext").organization.metadata) })
    },
  )

  app.put(
    "/v1/org/ai-gateway-settings",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Set AI Gateway settings",
      description: "Turns member AI Gateway API keys on or off for the organization. Turning it off stops every member key at the Gateway at once; the keys are kept and work again when it is turned back on. Requires Edit organization settings and the AI Gateway API keys feature.",
      responses: {
        200: jsonResponse("AI Gateway settings saved.", settingsViewSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: unauthorized,
        403: jsonResponse("The caller cannot edit organization settings.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    requireOrgPermission("organization.update"),
    jsonValidator(settingsInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const input = c.req.valid("json")
      const metadata = await updateOrganizationMetadata(c.get("organizationContext").organization.id, (current) => withOrganizationAiGatewaySettings(current, input))
      return c.json({ settings: readOrganizationAiGatewaySettings(metadata) })
    },
  )

  app.get(
    "/v1/org/ai-gateway/api-keys/mine",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "List my AI Gateway API keys",
      description: "Returns the caller's AI Gateway API keys that are not revoked, expired ones included (never the secret), whether the organization allows member keys, and the Gateway URL to point tools at. Needs the AI Gateway API keys feature.",
      responses: { 200: jsonResponse("Keys returned.", memberGatewayApiKeysViewSchema), 401: unauthorized, 404: notFound },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      return c.json({
        enabled: memberApiKeysAllowed(context.organization.metadata),
        baseUrl: gatewayApiBaseUrl(),
        apiKeys: await listMemberGatewayApiKeys({ organizationId: context.organization.id, memberId: context.currentMember.id }),
      })
    },
  )

  app.post(
    "/v1/org/ai-gateway/api-keys/mine",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Create an AI Gateway API key",
      description: `Creates an AI Gateway API key for the caller, with a name and an optional expiry, and returns it once; Den keeps only a digest. An expired key is refused by the Gateway. The key reaches the models the caller's grants allow, through GET /api/v1/models and the provider-less endpoints. A member may hold ${GATEWAY_API_KEY_MEMBER_LIMIT} unexpired keys. Refused while the organization does not allow member keys. Needs the AI Gateway API keys feature.`,
      responses: {
        201: jsonResponse("Key created.", createdGatewayApiKeySchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: unauthorized,
        404: notFound,
        409: jsonResponse("Member keys are off for the organization, or the caller holds the most keys allowed.", errorSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    jsonValidator(createInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      if (!memberApiKeysAllowed(context.organization.metadata)) {
        return c.json({ error: "member_api_keys_disabled", message: "Your organization does not allow AI Gateway API keys. Ask an admin to turn them on in Settings." }, 409)
      }
      const input = c.req.valid("json")
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        return c.json({ error: "invalid_request", details: [{ message: "expiresAt must be in the future.", path: ["expiresAt"] }] }, 400)
      }
      try {
        const created = await createMemberGatewayApiKey({ organizationId: context.organization.id, memberId: context.currentMember.id, name: input.name, expiresAt })
        return c.json(created, 201)
      } catch (error) {
        if (error instanceof GatewayApiKeyLimitError) {
          return c.json({ error: "gateway_api_key_limit", message: `You can have up to ${GATEWAY_API_KEY_MEMBER_LIMIT} keys. Revoke one you no longer use first.` }, 409)
        }
        throw error
      }
    },
  )

  app.delete(
    "/v1/org/ai-gateway/api-keys/mine/:apiKeyId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Revoke my AI Gateway API key",
      description: "Revokes one of the caller's AI Gateway API keys; the Gateway refuses it from the next request. Works while member keys are off. Needs the AI Gateway API keys feature.",
      responses: { 204: { description: "Key revoked." }, 400: jsonResponse("The key id is invalid.", invalidRequestSchema), 401: unauthorized, 404: keyNotFound },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    paramValidator(apiKeyParamsSchema),
    async (c) => {
      const context = c.get("organizationContext")
      const revoked = await revokeGatewayApiKey({
        organizationId: context.organization.id,
        apiKeyId: c.req.valid("param").apiKeyId,
        revokedByMemberId: context.currentMember.id,
        ownerMemberId: context.currentMember.id,
      })
      if (!revoked) return c.json({ error: "gateway_api_key_not_found" }, 404)
      return c.body(null, 204)
    },
  )

  app.get(
    "/v1/org/ai-gateway/api-keys",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "List the organization's AI Gateway API keys",
      description: "Returns every AI Gateway API key members of the organization created that is not revoked, expired ones included (never the secret), with the member each belongs to, and whether member keys are allowed. Requires the View Gateway providers permission and the AI Gateway API keys feature.",
      responses: {
        200: jsonResponse("Keys returned.", organizationGatewayApiKeysViewSchema),
        401: unauthorized,
        403: jsonResponse("The caller lacks the View Gateway providers permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    requireOrgPermission("gateway_providers.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      return c.json({
        enabled: memberApiKeysAllowed(context.organization.metadata),
        apiKeys: await listOrganizationGatewayApiKeys(context.organization.id),
      })
    },
  )

  app.delete(
    "/v1/org/ai-gateway/api-keys/:apiKeyId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Revoke a member's AI Gateway API key",
      description: "Revokes any member's AI Gateway API key in the organization; the Gateway refuses it from the next request. Requires the Manage Gateway providers permission, a recent sign-in and the AI Gateway API keys feature.",
      responses: {
        204: { description: "Key revoked." },
        400: jsonResponse("The key id is invalid.", invalidRequestSchema),
        401: unauthorized,
        403: jsonResponse("The caller lacks the Manage Gateway providers permission or needs to sign in again.", forbiddenSchema),
        404: keyNotFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("gatewayMemberApiKeys"),
    requireOrgPermission("gateway_providers.manage"),
    paramValidator(apiKeyParamsSchema),
    async (c) => {
      const context = c.get("organizationContext")
      const revoked = await revokeGatewayApiKey({
        organizationId: context.organization.id,
        apiKeyId: c.req.valid("param").apiKeyId,
        revokedByMemberId: context.currentMember.id,
      })
      if (!revoked) return c.json({ error: "gateway_api_key_not_found" }, 404)
      return c.body(null, 204)
    },
  )
}
