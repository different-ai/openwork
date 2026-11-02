import type { DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AUTO_ROUTER_MAX_ROUTERS,
  autoRouterConnectSchema,
  autoRouterListSchema,
  autoRouterModelId,
  autoRouterModelName,
  autoRouterAssignmentWriteSchema,
  autoRouterOptionsSchema,
  autoRouterSavedSchema,
  autoRouterWriteSchema,
  type AutoRouterAssignmentWrite,
  type AutoRouterConnect,
  type AutoRouterWrite,
} from "@openwork/types/den/auto-router"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import {
  checkAutoRouterAssignment,
  checkAutoRouterWrite,
  deleteAutoRouter,
  listAutoRouterOptions,
  listAutoRouters,
  memberAutoRouters,
  readAutoRouterRouting,
  saveAutoRouter,
  saveAutoRouterAssignment,
} from "../../auto-router.js"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { ensureMemberGatewayKey } from "../../gateway-keys.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { ResourceActionContext } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, permissionDeniedResponse, permissionFailureHeaders, type PermissionRouteContext } from "./shared.js"

const notConfiguredSchema = z
  .object({ error: z.literal("auto_router_not_configured"), message: z.string() })
  .meta({ ref: "AutoRouterNotConfiguredError" })

export const AUTO_ROUTER_NOT_CONFIGURED_MESSAGE = "The AI Gateway is missing its routing key. Ask the person who runs your OpenWork instance to add a TypeSafe API key to the AI Gateway, then save your Smart Routers."

const ORG_WIDE_SHARE_DENIED_MESSAGE = "You can't make a Smart Router apply to everyone in the organization. Choose specific people or teams instead."

const writeProblemSchema = z
  .object({
    error: z.enum(["unknown_model", "unknown_team", "unknown_member", "too_many_routers"]),
    model: z.number().int().optional(),
    message: z.string(),
  })
  .meta({ ref: "AutoRouterWriteProblem" })

const routerParamsSchema = idParamSchema("routerId", "autoRouter")
const notFound = jsonResponse("The organization or Smart Router was not found, or the Smart Model Router feature is off.", notFoundSchema)
const unauthorized = jsonResponse("Authentication required.", unauthorizedSchema)
const manageForbidden = jsonResponse("The caller lacks the Manage Gateway providers permission or needs to sign in again.", forbiddenSchema)

async function listView(c: PermissionRouteContext, organizationId: DenTypeId<"organization">) {
  const [list, routing, canEdit] = await Promise.all([listAutoRouters(organizationId), readAutoRouterRouting(), hasPermission(c, "gateway_providers.manage")])
  return { ...list, routing, canEdit }
}

/** Returns the caller's Gateway key, so agents never see it. */
function secretRoute(options: DescribeRouteOptions): DescribeRouteOptions & { "x-mcp": false } {
  return { ...options, "x-mcp": false }
}

/** The gateway's OpenAI-compatible base, the same origin Gateway providers' configs point at. */
function gatewayBaseUrl() {
  return `${env.gatewayPublicBaseUrl.replace(/\/+$/, "")}/api/v1`
}

const writeResponses = {
  400: jsonResponse("The request is invalid (for example a model without tasks), or names a model the AI Gateway does not offer.", z.union([writeProblemSchema, invalidRequestSchema])),
  409: jsonResponse("Refused because the AI Gateway has no routing (TypeSafe) key.", notConfiguredSchema),
  401: unauthorized,
  403: manageForbidden,
  404: notFound,
}

const assignmentResponses = {
  200: jsonResponse("Who the Smart Router applies to was saved.", autoRouterSavedSchema),
  400: jsonResponse("The request is invalid, or names a team or person that is not in the organization.", z.union([writeProblemSchema, invalidRequestSchema])),
  401: unauthorized,
  403: jsonResponse("The caller lacks the Manage Gateway providers permission, needs to sign in again, or makes the router apply to everyone without the Share with everyone permission.", forbiddenSchema),
  404: notFound,
}

/**
 * Smart Model Router (feature `autoRouter`): admins create named routers,
 * assign each to everyone, teams or members, and list AI Gateway models with
 * the tasks each handles; members pick "Smart: <name>" in the desktop and the
 * gateway routes each prompt (packages/types/src/den/auto-router.ts).
 */
export function registerOrgAutoRouterRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  /** Checks a name-and-models write and saves it; the response is the whole list and the router's id. */
  async function save(c: ResourceActionContext & PermissionRouteContext, write: AutoRouterWrite, routerId?: string) {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    const organizationId = payload.organization.id
    if (await readAutoRouterRouting() === "missing_key") {
      return c.json({ error: "auto_router_not_configured" as const, message: AUTO_ROUTER_NOT_CONFIGURED_MESSAGE }, 409)
    }
    if (routerId === undefined && (await listAutoRouters(organizationId)).routers.length >= AUTO_ROUTER_MAX_ROUTERS) {
      return c.json({ error: "too_many_routers" as const, message: `An organization can have at most ${AUTO_ROUTER_MAX_ROUTERS} Smart Routers.` }, 400)
    }
    const problem = checkAutoRouterWrite(write, await listAutoRouterOptions(organizationId))
    if (problem) return c.json(problem, 400)
    const saved = await saveAutoRouter({ organizationId, memberId: payload.currentMember.id, routerId, write })
    if (!saved) return c.json({ error: "auto_router_not_found" }, 404)
    return c.json({ ...await listView(c, organizationId), routerId: saved })
  }

  /** Checks who a router should apply to and saves it. */
  async function saveAssignment(c: ResourceActionContext & PermissionRouteContext, write: AutoRouterAssignmentWrite, routerId: string) {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    const organizationId = payload.organization.id
    const problem = await checkAutoRouterAssignment(organizationId, write.assignment)
    if (problem) return c.json(problem, 400)
    // Everyone reaches every member, so it needs Share with everyone on its own;
    // keeping an already org-wide router org-wide shares nothing new. The save
    // decides that under the router's lock.
    const result = await saveAutoRouterAssignment({
      organizationId,
      memberId: payload.currentMember.id,
      routerId,
      assignment: write.assignment,
      canShareWithEveryone: !write.assignment.everyone || await hasPermission(c, "sharing.share_org_wide"),
    })
    if (result === "not_found") return c.json({ error: "auto_router_not_found" }, 404)
    if (result === "needs_share_with_everyone") {
      const denied = { ...permissionDeniedResponse("sharing.share_org_wide"), message: ORG_WIDE_SHARE_DENIED_MESSAGE }
      return c.json(denied, 403, permissionFailureHeaders(denied))
    }
    return c.json({ ...await listView(c, organizationId), routerId })
  }

  app.get(
    "/v1/org/auto-routers",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "List Smart Routers",
      description: "Returns the organization's Smart Routers, oldest first: each one's name, who it applies to (everyone, teams, members), and its AI Gateway models with the tasks each handles. Also returns every task in the organization and whether the AI Gateway can route (routing: ready, missing_key when it has no TypeSafe key, or unknown when it could not be reached). Requires the View Gateway providers permission and the Smart Model Router feature.",
      responses: {
        200: jsonResponse("Smart Routers returned.", autoRouterListSchema),
        401: unauthorized,
        403: jsonResponse("The caller lacks the View Gateway providers permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json(await listView(c, c.get("organizationContext").organization.id))
    },
  )

  app.get(
    "/v1/org/auto-router/options",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "List models for Smart Routers",
      description: "Lists the AI Gateway models a Smart Router can use, and who can use each through the AI Gateway's access grants (everyone, team ids, member ids). Only models in an active model group of an active provider, whose protocol the gateway can route Smart requests to, are listed. Requires the View Gateway providers permission and the Smart Model Router feature.",
      responses: {
        200: jsonResponse("Models returned.", autoRouterOptionsSchema),
        401: unauthorized,
        403: jsonResponse("The caller lacks the View Gateway providers permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json({ options: await listAutoRouterOptions(c.get("organizationContext").organization.id) })
    },
  )

  app.post(
    "/v1/org/auto-routers",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Create a Smart Router",
      description: "Creates a Smart Router: its name and its AI Gateway models in order, each with the tasks it handles (at least one). It applies to nobody until who it applies to is set with PUT /v1/org/auto-routers/{routerId}/assignment. Tasks are shared across the organization and matched case-insensitively; new names are created. The first model wins ties and is used when the router cannot decide. Refused with auto_router_not_configured while the AI Gateway has no TypeSafe key. Requires the Manage Gateway providers permission, a recent sign-in and the Smart Model Router feature. Returns the whole list and the new router's id.",
      responses: { 200: jsonResponse("Smart Router created.", autoRouterSavedSchema), ...writeResponses },
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.manage"),
    jsonValidator(autoRouterWriteSchema),
    async (c) => save(c, c.req.valid("json")),
  )

  app.put(
    "/v1/org/auto-routers/:routerId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Update a Smart Router",
      description: "Replaces a Smart Router's name and models with their tasks; who it applies to is kept. Tasks no model uses anymore are removed from the organization. Requires the Manage Gateway providers permission, a recent sign-in and the Smart Model Router feature. Returns the whole list and the router's id.",
      responses: { 200: jsonResponse("Smart Router saved.", autoRouterSavedSchema), ...writeResponses },
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.manage"),
    paramValidator(routerParamsSchema),
    jsonValidator(autoRouterWriteSchema),
    async (c) => save(c, c.req.valid("json"), c.req.valid("param").routerId),
  )

  app.put(
    "/v1/org/auto-routers/:routerId/assignment",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Set who a Smart Router applies to",
      description: "Replaces who a Smart Router applies to: everyone, teams and members. Members it applies to get \"Smart: <name>\" in the desktop at their next provider sync, when they can use at least one of its models. Making it apply to everyone also needs the Share with everyone permission. Requires the Manage Gateway providers permission, a recent sign-in and the Smart Model Router feature. Returns the whole list and the router's id.",
      responses: assignmentResponses,
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.manage"),
    paramValidator(routerParamsSchema),
    jsonValidator(autoRouterAssignmentWriteSchema),
    async (c) => saveAssignment(c, c.req.valid("json"), c.req.valid("param").routerId),
  )

  app.delete(
    "/v1/org/auto-routers/:routerId",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Delete a Smart Router",
      description: "Deletes a Smart Router; members it applied to lose its Smart model at their next provider sync. Tasks no other router uses are removed. Requires the Manage Gateway providers permission, a recent sign-in and the Smart Model Router feature. Returns the whole list.",
      responses: {
        200: jsonResponse("Smart Router deleted.", autoRouterListSchema),
        400: jsonResponse("The router id is invalid.", invalidRequestSchema),
        401: unauthorized,
        403: manageForbidden,
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.manage"),
    paramValidator(routerParamsSchema),
    async (c) => {
      const organizationId = c.get("organizationContext").organization.id
      if (!await deleteAutoRouter(organizationId, c.req.valid("param").routerId)) return c.json({ error: "auto_router_not_found" }, 404)
      return c.json(await listView(c, organizationId))
    },
  )

  app.get(
    "/v1/org/auto-router/connect",
    describeRoute(secretRoute({
      tags: ["Inference Providers"],
      summary: "Connect to Smart",
      description: "For desktops: returns the OpenAI-compatible gateway base URL, the caller's own Gateway key, and one model per Smart Router that applies to the caller and has at least one model they can use (named \"Smart: <router name>\"). Answers 404 when there is none, including while the AI Gateway has no TypeSafe key. Never returns provider secrets. Requires organization membership and the Smart Model Router feature.",
      responses: {
        200: jsonResponse("Connection returned.", autoRouterConnectSchema),
        401: unauthorized,
        404: jsonResponse("No Smart Router applies to the caller, none of their models are available to the caller, or the AI Gateway cannot route.", notFoundSchema),
      },
    })),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      if (await readAutoRouterRouting() === "missing_key") return c.json({ error: "auto_router_unavailable" }, 404)
      const routers = await memberAutoRouters(organizationId, payload.currentMember.id)
      if (routers.length === 0) return c.json({ error: "auto_router_unavailable" }, 404)
      const apiKey = await ensureMemberGatewayKey({ organizationId, memberId: payload.currentMember.id })
      const response: AutoRouterConnect = {
        baseURL: gatewayBaseUrl(),
        apiKey,
        models: routers.map((router) => ({ id: autoRouterModelId(router.id), name: autoRouterModelName(router.name) })),
      }
      return c.json(response)
    },
  )
}
