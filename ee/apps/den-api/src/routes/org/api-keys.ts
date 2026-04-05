import type { Hono } from "hono"
import { z } from "zod"
import {
  buildOrganizationApiKeyMetadata,
  deleteOrganizationApiKey,
  DEN_API_KEY_RATE_LIMIT_MAX,
  DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
  listOrganizationApiKeys,
} from "../../api-keys.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { auth } from "../../auth.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureApiKeyManager, idParamSchema, orgIdParamSchema } from "./shared.js"

const createOrganizationApiKeySchema = z.object({
  name: z.string().trim().min(2).max(64),
})

const apiKeyIdParamSchema = orgIdParamSchema.extend(idParamSchema("apiKeyId").shape)

export function registerOrgApiKeyRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/orgs/:orgId/api-keys",
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
