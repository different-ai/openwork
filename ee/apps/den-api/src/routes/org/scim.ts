import type { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { deleteOrganizationScimConnection, getOrganizationScimConnection, getScimBaseUrl, rotateOrganizationScimToken } from "../../scim.js"
import { requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureScimManager } from "./shared.js"

const invalidRequestSchema = z.object({
  error: z.literal("invalid_request"),
  details: z.array(z.object({
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  }).passthrough()),
}).meta({ ref: "ScimInvalidRequestError" })

const unauthorizedSchema = z.object({
  error: z.literal("unauthorized"),
}).meta({ ref: "ScimUnauthorizedError" })

const organizationNotFoundSchema = z.object({
  error: z.literal("organization_not_found"),
}).meta({ ref: "ScimOrganizationNotFoundError" })

const forbiddenSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string(),
}).meta({ ref: "ScimForbiddenError" })

const scimConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  organizationId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "OrganizationScimConnection" })

const scimConnectionResponseSchema = z.object({
  baseUrl: z.string().url(),
  connection: scimConnectionSchema.nullable(),
}).meta({ ref: "OrganizationScimConnectionResponse" })

const rotateScimTokenResponseSchema = z.object({
  baseUrl: z.string().url(),
  connection: scimConnectionSchema,
  scimToken: z.string().min(1),
}).meta({ ref: "RotateOrganizationScimTokenResponse" })

function serializeConnection(connection: NonNullable<Awaited<ReturnType<typeof getOrganizationScimConnection>>>) {
  return {
    id: connection.id,
    providerId: connection.providerId,
    organizationId: connection.organizationId,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

export function registerOrgScimRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/scim",
    describeRoute({
      tags: ["SCIM"],
      summary: "Get organization SCIM connection",
      description: "Returns the SCIM User provisioning base URL and current connector metadata for the selected organization. SCIM Groups are not enabled yet.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "Organization SCIM configuration",
          content: {
            "application/json": {
              schema: resolver(scimConnectionResponseSchema),
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
          description: "Only workspace owners and admins can manage SCIM.",
          content: {
            "application/json": {
              schema: resolver(forbiddenSchema),
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
    resolveOrganizationContextMiddleware,
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, access.response.error === "forbidden" ? 403 : 404)
      }

      const payload = c.get("organizationContext")
      const connection = await getOrganizationScimConnection(payload.organization.id)

      return c.json({
        baseUrl: getScimBaseUrl(),
        connection: connection ? serializeConnection(connection) : null,
      })
    },
  )

  app.post(
    "/v1/scim/token",
    describeRoute({
      tags: ["SCIM"],
      summary: "Create or rotate an organization SCIM token",
      description: "Creates the organization SCIM User provisioning connector if needed and returns a freshly rotated bearer token. SCIM Groups are not enabled yet.",
      hide: process.env.NODE_ENV === "production",
      security: [{ bearerAuth: [] }],
      responses: {
        201: {
          description: "Organization SCIM token created",
          content: {
            "application/json": {
              schema: resolver(rotateScimTokenResponseSchema),
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
          description: "Only workspace owners and admins can manage SCIM.",
          content: {
            "application/json": {
              schema: resolver(forbiddenSchema),
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
    resolveOrganizationContextMiddleware,
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, access.response.error === "forbidden" ? 403 : 404)
      }

      const payload = c.get("organizationContext")
      const rotated = await rotateOrganizationScimToken({
        organizationId: payload.organization.id,
        headers: c.req.raw.headers,
      })

      return c.json({
        baseUrl: getScimBaseUrl(),
        connection: serializeConnection(rotated.connection),
        scimToken: rotated.scimToken,
      }, 201)
    },
  )

  app.delete(
    "/v1/scim",
    describeRoute({
      tags: ["SCIM"],
      summary: "Delete an organization SCIM connection",
      description: "Deletes the organization SCIM connection and invalidates the current bearer token.",
      security: [{ bearerAuth: [] }],
      responses: {
        204: {
          description: "Organization SCIM connection deleted",
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
          description: "Only workspace owners and admins can manage SCIM.",
          content: {
            "application/json": {
              schema: resolver(forbiddenSchema),
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
    resolveOrganizationContextMiddleware,
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, access.response.error === "forbidden" ? 403 : 404)
      }

      const payload = c.get("organizationContext")
      await deleteOrganizationScimConnection(payload.organization.id)
      return c.body(null, 204)
    },
  )
}
