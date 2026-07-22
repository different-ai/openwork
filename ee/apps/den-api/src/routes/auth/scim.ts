import { describeRoute } from "hono-openapi"
import type { Hono } from "hono"
import { resolver } from "hono-openapi"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { auth } from "../../auth.js"
import { deleteScimProvisionedAccessForProvider, recordScimSyncFailure, recordScimSyncFailureFromBearerToken, resolveScimProviderFromBearerToken, syncExternalIdentityFromScimResource, syncExternalIdentityFromScimUserId } from "../../scim.js"
import {
  applyScimGroupPatch,
  createScimGroup,
  deleteScimGroup,
  getScimGroup,
  listScimGroups,
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_RESPONSE_SCHEMA,
  SCIM_PATCH_SCHEMA,
  serializeScimGroup,
  updateScimGroup,
} from "../../scim-groups.js"
import { authenticatedRoute, tokenRoute } from "../../middleware/index.js"
import { appLogger } from "../../observability/logger.js"
import type { AuthContextVariables } from "../../session.js"

const scimErrorSchema = z.object({
  detail: z.string(),
}).meta({ ref: "ScimAuthRouteError" })

const scimManagementForbiddenSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string(),
}).meta({ ref: "ScimManagementForbiddenError" })
const logger = appLogger.child({ component: "scim_auth_routes" })

const scimGroupMemberSchema = z.object({
  value: z.string().trim().min(1),
  display: z.string().optional(),
  $ref: z.string().optional(),
}).passthrough()

const scimGroupInputSchema = z.object({
  schemas: z.array(z.string()).optional(),
  externalId: z.string().trim().min(1).nullable().optional(),
  displayName: z.string().trim().min(1),
  members: z.array(scimGroupMemberSchema).optional(),
}).passthrough()

const scimGroupPatchSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(z.object({
    op: z.preprocess(
      (value) => typeof value === "string" ? value.toLowerCase() : value,
      z.enum(["add", "remove", "replace"]),
    ),
    path: z.string().optional(),
    value: z.unknown().optional(),
  })).min(1),
}).passthrough()

function scimJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json" },
  })
}

function scimError(detail: string, status: number) {
  return scimJson({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail,
    status: String(status),
  }, status)
}

async function resolveRequestScimProvider(request: Request) {
  const bearerToken = readBearerToken(request.headers)
  if (!bearerToken) {
    return null
  }
  return resolveScimProviderFromBearerToken(bearerToken)
}

async function appendScimMetadataResource(request: Request, resource: Record<string, unknown>) {
  const response = await auth.handler(request)
  if (!response.ok) {
    return response
  }
  const payload: unknown = await response.json().catch(() => null)
  const record = isScimResource(payload) ? payload : {}
  const existingResources = Array.isArray(record.Resources)
    ? record.Resources.filter(isScimResource)
    : []
  const resourceId = typeof resource.id === "string" ? resource.id : null
  const resources = resourceId && existingResources.some((entry) => entry.id === resourceId)
    ? existingResources
    : [...existingResources, resource]
  return scimJson({
    ...record,
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  })
}

function readBearerToken(headers: Headers) {
  const header = headers.get("authorization")?.trim() ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

function logScimSyncWarning(action: string, error: unknown) {
  logger.warn("external identity sync failed", { action, error })
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
    logger.error("sync failure record failed", { error })
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

  app.get("/api/auth/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    return scimJson({
      id: SCIM_GROUP_SCHEMA,
      name: "Group",
      description: "Group",
      attributes: [
        { name: "displayName", type: "string", multiValued: false, required: true, mutability: "readWrite", returned: "default", uniqueness: "none" },
        { name: "members", type: "complex", multiValued: true, required: false, mutability: "readWrite", returned: "default", uniqueness: "none" },
      ],
      meta: { resourceType: "Schema", location: `${c.req.url}` },
    })
  })

  app.get("/api/auth/scim/v2/Schemas", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    return appendScimMetadataResource(c.req.raw, {
      id: SCIM_GROUP_SCHEMA,
      name: "Group",
      description: "Group",
      meta: { resourceType: "Schema", location: `${c.req.url}/${SCIM_GROUP_SCHEMA}` },
    })
  })

  app.get("/api/auth/scim/v2/ResourceTypes/Group", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    return scimJson({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP_SCHEMA,
      schemaExtensions: [],
    })
  })

  app.get("/api/auth/scim/v2/ResourceTypes", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    return appendScimMetadataResource(c.req.raw, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP_SCHEMA,
      schemaExtensions: [],
    })
  })

  app.get("/api/auth/scim/v2/Groups", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)

    const groups = await listScimGroups(provider)
    const filter = c.req.query("filter")?.trim() ?? ""
    const filterMatch = filter.match(/^(displayName|externalId)\s+eq\s+["']([^"']+)["']$/i)
    const filteredGroups = filterMatch?.[1] && filterMatch[2]
      ? groups.filter((group) => filterMatch[1]?.toLowerCase() === "displayname"
        ? group.displayName === filterMatch[2]
        : group.externalId === filterMatch[2])
      : groups
    const baseUrl = new URL(c.req.url)
    baseUrl.pathname = baseUrl.pathname.replace(/\/Groups$/, "")
    baseUrl.search = ""
    const resources = await Promise.all(filteredGroups.map((group) => serializeScimGroup(group, baseUrl.toString().replace(/\/$/, ""))))
    const requestedStartIndex = Number.parseInt(c.req.query("startIndex") ?? "1", 10)
    const requestedCount = Number.parseInt(c.req.query("count") ?? String(resources.length || 100), 10)
    const startIndex = Number.isFinite(requestedStartIndex) ? Math.max(1, requestedStartIndex) : 1
    const count = Number.isFinite(requestedCount) ? Math.max(0, requestedCount) : resources.length
    const page = resources.slice(startIndex - 1, startIndex - 1 + count)
    return scimJson({
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults: resources.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page,
    })
  })

  app.post("/api/auth/scim/v2/Groups", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    const parsed = scimGroupInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return scimError("Invalid SCIM Group resource", 400)
    const result = await createScimGroup({ provider, value: parsed.data })
    if (!result.ok) return scimError(result.detail, result.status)
    const baseUrl = c.req.url.replace(/\/Groups$/, "")
    return scimJson(await serializeScimGroup(result.group, baseUrl), 201)
  })

  app.get("/api/auth/scim/v2/Groups/:groupId", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    const group = await getScimGroup({ provider, groupId: c.req.param("groupId") })
    if (!group) return scimError("Group not found", 404)
    const baseUrl = c.req.url.replace(/\/Groups\/[^/]+$/, "")
    return scimJson(await serializeScimGroup(group, baseUrl))
  })

  app.put("/api/auth/scim/v2/Groups/:groupId", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    const parsed = scimGroupInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return scimError("Invalid SCIM Group resource", 400)
    const result = await updateScimGroup({ provider, groupId: c.req.param("groupId"), value: parsed.data })
    if (!result.ok) return scimError(result.detail, result.status)
    const baseUrl = c.req.url.replace(/\/Groups\/[^/]+$/, "")
    return scimJson(await serializeScimGroup(result.group, baseUrl))
  })

  app.patch("/api/auth/scim/v2/Groups/:groupId", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    const parsed = scimGroupPatchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success || (parsed.data.schemas && !parsed.data.schemas.includes(SCIM_PATCH_SCHEMA))) {
      return scimError("Invalid SCIM PATCH request", 400)
    }
    const group = await getScimGroup({ provider, groupId: c.req.param("groupId") })
    if (!group) return scimError("Group not found", 404)
    const baseUrl = c.req.url.replace(/\/Groups\/[^/]+$/, "")
    const current = await serializeScimGroup(group, baseUrl)
    const value = applyScimGroupPatch({ current, operations: parsed.data.Operations })
    const result = await updateScimGroup({ provider, groupId: group.id, value })
    if (!result.ok) return scimError(result.detail, result.status)
    return scimJson(await serializeScimGroup(result.group, baseUrl))
  })

  app.delete("/api/auth/scim/v2/Groups/:groupId", tokenRoute, async (c) => {
    const provider = await resolveRequestScimProvider(c.req.raw)
    if (!provider) return scimError("Invalid SCIM token", 401)
    const result = await deleteScimGroup({ provider, groupId: c.req.param("groupId") })
    if (!result.ok) return scimError(result.detail, result.status)
    return new Response(null, { status: 204 })
  })

  app.delete(
    "/api/auth/scim/v2/Users/:userId",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Delete SCIM provisioned org access",
      description: "Tombstones the organization member and deletes the global user only when no other active organization membership remains.",
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
