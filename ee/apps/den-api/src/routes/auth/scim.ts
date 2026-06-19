import { describeRoute } from "hono-openapi"
import type { Hono } from "hono"
import { resolver } from "hono-openapi"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { auth } from "../../auth.js"
import { deleteScimProvisionedAccessForProvider, recordScimSyncFailure, recordScimSyncFailureFromBearerToken, resolveScimProviderFromBearerToken, syncExternalIdentityFromScimResource, syncExternalIdentityFromScimUserId } from "../../scim.js"
import { authenticatedRoute, publicRoute, tokenRoute } from "../../middleware/index.js"
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

export type ScimSyncAction = "sync_resource" | "sync_user_id" | "delete_user"
export type ScimSyncResult =
  | { ok: true; required: boolean }
  | { ok: false; action: ScimSyncAction; message: string }

function failedScimSync(action: ScimSyncAction, error: unknown): ScimSyncResult {
  const message = error instanceof Error ? error.message : String(error)
  logScimSyncWarning(action, error)
  return { ok: false, action, message }
}

function isScimResource(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function getScimResponsePayload(response: Response) {
  const payload: unknown = await response.clone().json().catch(() => null)
  return isScimResource(payload) ? payload : null
}

function maybeNormalizeUserId(value: string | undefined) {
  if (!value) {
    return null
  }

  try {
    return normalizeDenTypeId("user", value)
  } catch {
    return null
  }
}

async function recordScimFailureSafely(recordFailure: () => Promise<unknown>) {
  try {
    await recordFailure()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[scim][sync_failure_record_failed] reason=${message}`)
  }
}

export function createScimSyncFailureResponse(result: Extract<ScimSyncResult, { ok: false }>) {
  return new Response(JSON.stringify({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail: "SCIM user mutation completed, but external identity sync failed; retry later.",
    status: "503",
    action: result.action,
  }), {
    status: 503,
    headers: {
      "content-type": "application/scim+json",
      "retry-after": "60",
    },
  })
}

export async function syncScimMutationFromResponse(input: {
  bearerToken: string
  response: Response
  fallbackUserId?: string
  syncResource?: typeof syncExternalIdentityFromScimResource
  syncUserId?: typeof syncExternalIdentityFromScimUserId
}): Promise<ScimSyncResult> {
  if (!input.response.ok) {
    return { ok: true, required: false }
  }

  const syncResource = input.syncResource ?? syncExternalIdentityFromScimResource
  const syncUserId = input.syncUserId ?? syncExternalIdentityFromScimUserId

  if (input.response.status === 204 && input.fallbackUserId) {
    try {
      const synced = await syncUserId({
        bearerToken: input.bearerToken,
        userId: normalizeDenTypeId("user", input.fallbackUserId),
      })
      if (!synced) {
        return failedScimSync("sync_user_id", "external identity sync returned false")
      }
    } catch (error) {
      return failedScimSync("sync_user_id", error)
    }
    return { ok: true, required: true }
  }

  const payload: unknown = await input.response.clone().json().catch(() => null)
  if (!isScimResource(payload)) {
    return failedScimSync("sync_resource", "SCIM response body was not a JSON object")
  }

  try {
    const synced = await syncResource({
      bearerToken: input.bearerToken,
      resource: payload,
    })
    if (!synced) {
      return failedScimSync("sync_resource", "external identity sync returned false")
    }
  } catch (error) {
    return failedScimSync("sync_resource", error)
  }

  return { ok: true, required: true }
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
    authenticatedRoute(),
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
    authenticatedRoute(),
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
    authenticatedRoute(),
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
    authenticatedRoute(),
    (c) => rejectManagementRoute(c),
  )

  app.all("/api/auth/scim/v2/Groups", publicRoute, (c) => scimGroupsNotSupported(c))
  app.all("/api/auth/scim/v2/Groups/:groupId", publicRoute, (c) => scimGroupsNotSupported(c))

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
    tokenRoute,
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

      const provider = await resolveScimProviderFromBearerToken(bearerToken)
      if (!provider) {
        return c.json({ detail: "Invalid SCIM token" }, 401)
      }

      let deleted: Awaited<ReturnType<typeof deleteScimProvisionedAccessForProvider>>
      try {
        deleted = await deleteScimProvisionedAccessForProvider({
          provider,
          userId: normalizedUserId,
        })
      } catch (error) {
        await recordScimFailureSafely(() =>
          recordScimSyncFailure({
            provider,
            action: "delete_user",
            userId: normalizedUserId,
            payloadJson: { userId: normalizedUserId },
            error,
          }),
        )
        return createScimSyncFailureResponse({
          ok: false,
          action: "delete_user",
          message: error instanceof Error ? error.message : String(error),
        })
      }

      if (!deleted.ok) {
        if (deleted.status === 409) {
          await recordScimFailureSafely(() =>
            recordScimSyncFailure({
              provider,
              action: "delete_user",
              userId: normalizedUserId,
              payloadJson: { userId: normalizedUserId },
              error: deleted.body.detail,
            }),
          )
        }
        return c.json(deleted.body, { status: deleted.status as 401 | 404 | 409 })
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

    const syncResult = await syncScimMutationFromResponse({
      bearerToken,
      response,
      fallbackUserId: c.req.param("userId") || undefined,
    })
    if (!syncResult.ok) {
      await recordScimFailureSafely(async () =>
        recordScimSyncFailureFromBearerToken({
          bearerToken,
          action: syncResult.action,
          userId: maybeNormalizeUserId(c.req.param("userId")),
          payloadJson: response.status === 204
            ? { userId: c.req.param("userId") }
            : await getScimResponsePayload(response),
          error: syncResult.message,
        }),
      )
      return createScimSyncFailureResponse(syncResult)
    }
    return response
  }

  app.post("/api/auth/scim/v2/Users", tokenRoute, async (c) => handleScimMutation(c))
  app.put("/api/auth/scim/v2/Users/:userId", tokenRoute, async (c) => handleScimMutation(c))
  app.patch("/api/auth/scim/v2/Users/:userId", tokenRoute, async (c) => handleScimMutation(c))
}
