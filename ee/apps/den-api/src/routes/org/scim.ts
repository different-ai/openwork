import type { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { deleteOrganizationScimConnection, getOrganizationScimConnection, getOrganizationScimHealth, getScimBaseUrl, reconcileOrganizationScimDrift, rotateOrganizationScimToken } from "../../scim.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { orgMemberRoute } from "../../middleware/index.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureScimManager, orgAccessFailureStatus } from "./shared.js"

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
  error: z.enum(["forbidden", "reauth"]),
  reason: z.string().optional(),
  message: z.string(),
}).meta({ ref: "ScimForbiddenError" })

const scimConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  organizationId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "OrganizationScimConnection" })

const scimHealthSchema = z.object({
  unresolvedFailureCount: z.number().int().nonnegative(),
  lastFailureAt: z.string().datetime().nullable(),
  lastFailureAction: z.string().nullable(),
  lastFailureMessage: z.string().nullable(),
  nextRetryAt: z.string().datetime().nullable(),
  lastSuccessfulSyncAt: z.string().datetime().nullable(),
}).meta({ ref: "OrganizationScimHealth" })

const scimConnectionResponseSchema = z.object({
  baseUrl: z.string().url(),
  connection: scimConnectionSchema.nullable(),
  health: scimHealthSchema,
}).meta({ ref: "OrganizationScimConnectionResponse" })

const rotateScimTokenResponseSchema = z.object({
  baseUrl: z.string().url(),
  connection: scimConnectionSchema,
  scimToken: z.string().min(1),
  health: scimHealthSchema,
}).meta({ ref: "RotateOrganizationScimTokenResponse" })

const scimReconciliationResponseSchema = z.object({
  checked: z.number().int().nonnegative(),
  repaired: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
}).meta({ ref: "OrganizationScimReconciliationResponse" })

function serializeConnection(connection: NonNullable<Awaited<ReturnType<typeof getOrganizationScimConnection>>>) {
  return {
    id: connection.id,
    providerId: connection.providerId,
    organizationId: connection.organizationId,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

function serializeHealth(health: Awaited<ReturnType<typeof getOrganizationScimHealth>>) {
  return {
    unresolvedFailureCount: health.unresolvedFailureCount,
    lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
    lastFailureAction: health.lastFailureAction,
    lastFailureMessage: health.lastFailureMessage,
    nextRetryAt: health.nextRetryAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: health.lastSuccessfulSyncAt?.toISOString() ?? null,
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
          description: "Only workspace owners or members with security configuration permission can manage SCIM.",
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
    orgMemberRoute(),
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const [connection, health] = await Promise.all([
        getOrganizationScimConnection(payload.organization.id),
        getOrganizationScimHealth(payload.organization.id),
      ])

      return c.json({
        baseUrl: getScimBaseUrl(),
        connection: connection ? serializeConnection(connection) : null,
        health: serializeHealth(health),
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
          description: "Only workspace owners or members with security configuration permission can manage SCIM.",
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
    orgMemberRoute(),
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const rotated = await rotateOrganizationScimToken({
        organizationId: payload.organization.id,
        headers: c.req.raw.headers,
      })
      const health = await getOrganizationScimHealth(payload.organization.id)

      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.scimTokenRotated,
        payload: {
          scimProviderId: rotated.connection.id,
          providerId: rotated.connection.providerId,
        },
      })

      return c.json({
        baseUrl: getScimBaseUrl(),
        connection: serializeConnection(rotated.connection),
        scimToken: rotated.scimToken,
        health: serializeHealth(health),
      }, 201)
    },
  )

  app.post(
    "/v1/scim/reconcile",
    describeRoute({
      tags: ["SCIM"],
      summary: "Run organization SCIM drift reconciliation",
      description: "Checks local SCIM-managed identities for inconsistent organization membership or provider-account state and records unresolved drift for retry or manual review.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "SCIM reconciliation completed.",
          content: {
            "application/json": {
              schema: resolver(scimReconciliationResponseSchema),
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
          description: "Only workspace owners or members with security configuration permission can manage SCIM.",
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
    orgMemberRoute(),
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const result = await reconcileOrganizationScimDrift(payload.organization.id)
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.scimReconciliationRun,
        payload: result,
      })
      return c.json(result)
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
          description: "Only workspace owners or members with security configuration permission can manage SCIM.",
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
    orgMemberRoute(),
    async (c) => {
      const access = ensureScimManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const deleted = await deleteOrganizationScimConnection(payload.organization.id)
      if (deleted) {
        await recordOrganizationAuditEvent({
          organizationId: payload.organization.id,
          actorUserId: payload.currentMember.userId,
          action: ORGANIZATION_AUDIT_ACTIONS.scimConnectionDeleted,
        })
      }
      return c.body(null, 204)
    },
  )
}
