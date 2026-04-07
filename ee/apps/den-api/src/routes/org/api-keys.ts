import type { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import {
  buildOrganizationApiKeyMetadata,
  deleteOrganizationApiKey,
  DEN_API_KEY_RATE_LIMIT_MAX,
  DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
  listOrganizationApiKeys,
} from "../../api-keys.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema } from "../../openapi.js"
import { auth } from "../../auth.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureApiKeyManager, idParamSchema, orgIdParamSchema } from "./shared.js"

const createOrganizationApiKeySchema = z.object({
  name: z.string().trim().min(2).max(64),
}).meta({ ref: "CreateOrganizationApiKeyRequest" })

const validationIssueSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
}).passthrough()

const invalidRequestSchema = z.object({
  error: z.literal("invalid_request"),
  details: z.array(validationIssueSchema),
}).meta({ ref: "InvalidRequestError" })

const unauthorizedSchema = z.object({
  error: z.literal("unauthorized"),
}).meta({ ref: "UnauthorizedError" })

const organizationNotFoundSchema = z.object({
  error: z.literal("organization_not_found"),
}).meta({ ref: "OrganizationNotFoundError" })

const forbiddenApiKeyManagerSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string(),
}).meta({ ref: "OrganizationApiKeyForbiddenError" })

const apiKeyNotFoundSchema = z.object({
  error: z.literal("api_key_not_found"),
}).meta({ ref: "OrganizationApiKeyNotFoundError" })

const apiKeyOwnerSchema = z.object({
  userId: denTypeIdSchema("user"),
  memberId: denTypeIdSchema("member"),
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable(),
}).meta({ ref: "OrganizationApiKeyOwner" })

const organizationApiKeySchema = z.object({
  id: z.string(),
  configId: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  prefix: z.string().nullable(),
  enabled: z.boolean(),
  rateLimitEnabled: z.boolean(),
  rateLimitMax: z.number().int().nullable(),
  rateLimitTimeWindow: z.number().int().nullable(),
  lastRequest: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  owner: apiKeyOwnerSchema,
}).meta({ ref: "OrganizationApiKey" })

const organizationApiKeyListResponseSchema = z.object({
  apiKeys: z.array(organizationApiKeySchema),
}).meta({ ref: "OrganizationApiKeyListResponse" })

const createdOrganizationApiKeySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  prefix: z.string().nullable(),
  enabled: z.boolean(),
  rateLimitEnabled: z.boolean(),
  rateLimitMax: z.number().int().nullable(),
  rateLimitTimeWindow: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "CreatedOrganizationApiKey" })

const createOrganizationApiKeyResponseSchema = z.object({
  apiKey: createdOrganizationApiKeySchema,
  key: z.string().min(1),
}).meta({ ref: "CreateOrganizationApiKeyResponse" })

const apiKeyIdParamSchema = orgIdParamSchema.extend(idParamSchema("apiKeyId").shape)
const hideApiKeyGenerationRoute = () => process.env.NODE_ENV === "production"

export function registerOrgApiKeyRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/orgs/:orgId/api-keys",
    describeRoute({
      tags: ["API Keys"],
      summary: "List organization API keys",
      description: "Returns the API keys that belong to the selected organization.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "Organization API keys",
          content: {
            "application/json": {
              schema: resolver(organizationApiKeyListResponseSchema),
            },
          },
        },
        400: {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: resolver(invalidRequestSchema),
            },
          },
        },
        401: {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: resolver(unauthorizedSchema),
            },
          },
        },
        403: {
          description: "Only workspace owners and admins can list API keys.",
          content: {
            "application/json": {
              schema: resolver(forbiddenApiKeyManagerSchema),
            },
          },
        },
        404: {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: resolver(organizationNotFoundSchema),
            },
          },
        },
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const access = ensureApiKeyManager(c)
      if (!access.ok) {
        return c.json(access.response, access.response.error === "forbidden" ? 403 : 404)
      }

      const payload = c.get("organizationContext")
      const apiKeys = await listOrganizationApiKeys(payload.organization.id)
      return c.json({ apiKeys })
    },
  )

  app.post(
    "/v1/orgs/:orgId/api-keys",
    describeRoute({
      tags: ["API Keys"],
      summary: "Create an organization API key",
      description: "Creates a new API key for the selected organization.",
      hide: hideApiKeyGenerationRoute,
      security: [{ bearerAuth: [] }],
      responses: {
        201: {
          description: "Organization API key created",
          content: {
            "application/json": {
              schema: resolver(createOrganizationApiKeyResponseSchema),
            },
          },
        },
        400: {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: resolver(invalidRequestSchema),
            },
          },
        },
        401: {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: resolver(unauthorizedSchema),
            },
          },
        },
        403: {
          description: "Only workspace owners and admins can create API keys.",
          content: {
            "application/json": {
              schema: resolver(forbiddenApiKeyManagerSchema),
            },
          },
        },
        404: {
          description: "Organization not found",
          content: {
            "application/json": {
              schema: resolver(organizationNotFoundSchema),
            },
          },
        },
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(createOrganizationApiKeySchema),
    async (c) => {
      const access = ensureApiKeyManager(c)
      if (!access.ok) {
        return c.json(access.response, access.response.error === "forbidden" ? 403 : 404)
      }

      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const created = await auth.api.createApiKey({
        body: {
          userId: payload.currentMember.userId,
          name: input.name,
          metadata: buildOrganizationApiKeyMetadata({
            organizationId: payload.organization.id,
            orgMembershipId: payload.currentMember.id,
            issuedByUserId: payload.currentMember.userId,
            issuedByOrgMembershipId: payload.currentMember.id,
          }),
          rateLimitEnabled: true,
          rateLimitMax: DEN_API_KEY_RATE_LIMIT_MAX,
          rateLimitTimeWindow: DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
        },
      })

      return c.json({
        apiKey: {
          id: created.id,
          name: created.name,
          start: created.start,
          prefix: created.prefix,
          enabled: created.enabled,
          rateLimitEnabled: created.rateLimitEnabled,
          rateLimitMax: created.rateLimitMax,
          rateLimitTimeWindow: created.rateLimitTimeWindow,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
        key: created.key,
      }, 201)
    },
  )

  app.delete(
    "/v1/orgs/:orgId/api-keys/:apiKeyId",
    describeRoute({
      tags: ["API Keys"],
      hide: true,
      summary: "Delete an organization API key",
      description: "Deletes an API key from the selected organization.",
      security: [{ bearerAuth: [] }],
      responses: {
        204: {
          description: "Organization API key deleted",
        },
        400: {
          description: "Invalid request",
          content: {
            "application/json": {
              schema: resolver(invalidRequestSchema),
            },
          },
        },
        401: {
          description: "Unauthorized",
          content: {
            "application/json": {
              schema: resolver(unauthorizedSchema),
            },
          },
        },
        403: {
          description: "Only workspace owners and admins can delete API keys.",
          content: {
            "application/json": {
              schema: resolver(forbiddenApiKeyManagerSchema),
            },
          },
        },
        404: {
          description: "API key or organization not found",
          content: {
            "application/json": {
              schema: resolver(z.union([organizationNotFoundSchema, apiKeyNotFoundSchema])),
            },
          },
        },
      },
    }),
    requireUserMiddleware,
    paramValidator(apiKeyIdParamSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const access = ensureApiKeyManager(c)
      if (!access.ok) {
        return c.json(access.response, access.response.error === "forbidden" ? 403 : 404)
      }

      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const deleted = await deleteOrganizationApiKey({
        organizationId: payload.organization.id,
        apiKeyId: params.apiKeyId,
      })

      if (!deleted) {
        return c.json({ error: "api_key_not_found" }, 404)
      }

      return c.body(null, 204)
    },
  )
}
