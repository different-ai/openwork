import { describeRoute } from "hono-openapi"
import type { Hono } from "hono"
import { resolver } from "hono-openapi"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { auth } from "../../auth.js"
import { deleteScimProvisionedAccess, syncExternalIdentityFromScimResource, syncExternalIdentityFromScimUserId } from "../../scim.js"
import type { AuthContextVariables } from "../../session.js"

const scimErrorSchema = z.object({
  detail: z.string(),
}).meta({ ref: "ScimAuthRouteError" })

const scimManagementForbiddenSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string(),
}).meta({ ref: "ScimManagementForbiddenError" })

function readBearerToken(headers: Headers) {
  const header = headers.get("authorization")?.trim() ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

function logScimSyncWarning(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[scim][external_identity_sync_failed] action=${action} reason=${message}`)
}

async function syncScimMutationFromResponse(input: {
  bearerToken: string
  response: Response
  fallbackUserId?: string
}) {
  if (!input.response.ok) {
    return
  }

  if (input.response.status === 204 && input.fallbackUserId) {
    try {
      await syncExternalIdentityFromScimUserId({
        bearerToken: input.bearerToken,
        userId: normalizeDenTypeId("user", input.fallbackUserId),
      })
    } catch (error) {
      logScimSyncWarning("sync_user_id", error)
    }
    return
  }

  const payload = await input.response.clone().json().catch(() => null) as Record<string, unknown> | null
  if (!payload) {
    return
  }

  try {
    await syncExternalIdentityFromScimResource({
      bearerToken: input.bearerToken,
      resource: payload,
    })
  } catch (error) {
    logScimSyncWarning("sync_resource", error)
  }
}

export function registerScimAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const scimGroupsNotSupported = (c: { json: (object: unknown, status?: number | { status: number }) => Response }) => {
    return c.json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: "SCIM Groups are not supported yet.",
      status: "501",
    }, 501)
  }

  const rejectManagementRoute = (c: {
    get: (key: "user") => AuthContextVariables["user"]
    json: (object: unknown, status?: number | { status: number }) => Response
  }) => {
    const user = c.get("user")
    if (!user?.id) {
      return c.json({ error: "unauthorized" }, 401)
    }

    return c.json({
      error: "forbidden",
      message: "Use the organization SCIM endpoints instead of the raw Better Auth management routes.",
    }, 403)
  }

  app.post(
    "/api/auth/scim/generate-token",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Block raw SCIM token management",
      description: "Direct SCIM management is disabled in favor of org-scoped Den routes.",
      responses: {
        401: { description: "Unauthorized" },
        403: {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: resolver(scimManagementForbiddenSchema),
            },
          },
        },
      },
    }),
    (c) => rejectManagementRoute(c),
  )

  app.get(
    "/api/auth/scim/list-provider-connections",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Block raw SCIM provider listing",
      description: "Direct SCIM management is disabled in favor of org-scoped Den routes.",
      responses: {
        401: { description: "Unauthorized" },
        403: {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: resolver(scimManagementForbiddenSchema),
            },
          },
        },
      },
    }),
    (c) => rejectManagementRoute(c),
  )

  app.get(
    "/api/auth/scim/get-provider-connection",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Block raw SCIM provider lookup",
      description: "Direct SCIM management is disabled in favor of org-scoped Den routes.",
      responses: {
        401: { description: "Unauthorized" },
        403: {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: resolver(scimManagementForbiddenSchema),
            },
          },
        },
      },
    }),
    (c) => rejectManagementRoute(c),
  )

  app.post(
    "/api/auth/scim/delete-provider-connection",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Block raw SCIM provider deletion",
      description: "Direct SCIM management is disabled in favor of org-scoped Den routes.",
      responses: {
        401: { description: "Unauthorized" },
        403: {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: resolver(scimManagementForbiddenSchema),
            },
          },
        },
      },
    }),
    (c) => rejectManagementRoute(c),
  )

  app.all("/api/auth/scim/v2/Groups", (c) => scimGroupsNotSupported(c))
  app.all("/api/auth/scim/v2/Groups/:groupId", (c) => scimGroupsNotSupported(c))

  app.delete(
    "/api/auth/scim/v2/Users/:userId",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Delete SCIM provisioned org access",
      description: "Removes the organization membership and SCIM provider account without deleting the global app user.",
      responses: {
        204: {
          description: "SCIM provisioned org access deleted.",
        },
        401: {
          description: "Invalid SCIM token.",
          content: {
            "application/json": {
              schema: resolver(scimErrorSchema),
            },
          },
        },
        404: {
          description: "User not found.",
          content: {
            "application/json": {
              schema: resolver(scimErrorSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const bearerToken = readBearerToken(c.req.raw.headers)
      if (!bearerToken) {
        return c.json({ detail: "SCIM token is required" }, 401)
      }

      let normalizedUserId
      try {
        normalizedUserId = normalizeDenTypeId("user", c.req.param("userId"))
      } catch {
        return c.json({ detail: "User not found" }, 404)
      }

      const deleted = await deleteScimProvisionedAccess({
        bearerToken,
        userId: normalizedUserId,
      })

      if (!deleted.ok) {
        return c.json(deleted.body, { status: deleted.status as 401 | 404 })
      }

      return c.body(null, 204)
    },
  )

  const handleScimMutation = async (c: { req: { raw: Request; param: (key: string) => string } }) => {
    const bearerToken = readBearerToken(c.req.raw.headers)
    const response = await auth.handler(c.req.raw)
    if (!bearerToken) {
      return response
    }

    await syncScimMutationFromResponse({
      bearerToken,
      response,
      fallbackUserId: c.req.param("userId") || undefined,
    })
    return response
  }

  app.post("/api/auth/scim/v2/Users", async (c) => handleScimMutation(c))
  app.put("/api/auth/scim/v2/Users/:userId", async (c) => handleScimMutation(c))
  app.patch("/api/auth/scim/v2/Users/:userId", async (c) => handleScimMutation(c))
}
