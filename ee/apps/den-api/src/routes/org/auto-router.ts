import {
  AUTO_ROUTER_MODEL_ID,
  AUTO_ROUTER_MODEL_NAME,
  autoRouterConnectSchema,
  autoRouterOptionsSchema,
  autoRouterSettingsSchema,
  autoRouterWriteSchema,
  type AutoRouterConnect,
} from "@openwork/types/den/auto-router"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { checkAutoRouterWrite, listAutoRouterOptions, memberCanUseAutoRouter, readAutoRouter, readAutoRouterRouting, saveAutoRouter } from "../../auto-router.js"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { ensureMemberGatewayKey } from "../../gateway-keys.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, type PermissionRouteContext } from "./shared.js"

const notConfiguredSchema = z
  .object({ error: z.literal("auto_router_not_configured"), message: z.string() })
  .meta({ ref: "AutoRouterNotConfiguredError" })

export const AUTO_ROUTER_NOT_CONFIGURED_MESSAGE = "The AI Gateway is missing its routing key. Ask the person who runs your OpenWork instance to add a TypeSafe API key to the AI Gateway, then turn on the Auto Router."

const writeProblemSchema = z
  .object({ error: z.enum(["unknown_model", "unsupported_thinking_level"]), route: z.number().int(), message: z.string() })
  .meta({ ref: "AutoRouterWriteProblem" })

const notFound = jsonResponse("The organization was not found, or the Auto Router feature is off.", notFoundSchema)
const unauthorized = jsonResponse("Authentication required.", unauthorizedSchema)

async function settingsView(c: PermissionRouteContext, organizationId: Parameters<typeof readAutoRouter>[0]) {
  const [router, routing, canEdit] = await Promise.all([readAutoRouter(organizationId), readAutoRouterRouting(), hasPermission(c, "gateway_providers.manage")])
  return { ...router, routing, canEdit }
}

/** Returns the caller's Gateway key, so agents never see it. */
function secretRoute(options: DescribeRouteOptions): DescribeRouteOptions & { "x-mcp": false } {
  return { ...options, "x-mcp": false }
}

/** The gateway's OpenAI-compatible base, the same origin Gateway providers' configs point at. */
function gatewayBaseUrl() {
  return `${env.gatewayPublicBaseUrl.replace(/\/+$/, "")}/api/v1`
}

/**
 * Auto Router (feature `autoRouter`): admins choose AI Gateway models and
 * describe when to use each; members pick Auto in the desktop and the gateway
 * routes each prompt (packages/types/src/den/auto-router.ts).
 */
export function registerOrgAutoRouterRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/auto-router",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Get the Auto Router",
      description: "Returns whether the organization's Auto Router is enabled, whether the AI Gateway can route (routing: ready, missing_key when it has no TypeSafe key, or unknown when it could not be reached), and its routes in order: each AI Gateway model, when to use it, and the one thinking level it runs at. The first route is the default model, used when no other route matches, with a fixed prompt. Requires the View Gateway providers permission and the Auto Router feature.",
      responses: {
        200: jsonResponse("Auto Router returned.", autoRouterSettingsSchema),
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
      return c.json(await settingsView(c, c.get("organizationContext").organization.id))
    },
  )

  app.get(
    "/v1/org/auto-router/options",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "List models for the Auto Router",
      description: "Lists the AI Gateway models the Auto Router can use, with the thinking levels each allows. Only models in an active model group of an active provider, whose protocol the gateway can route Auto requests to, are listed. Requires the View Gateway providers permission and the Auto Router feature.",
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

  app.put(
    "/v1/org/auto-router",
    describeRoute({
      tags: ["Inference Providers"],
      summary: "Save the Auto Router",
      description: "Replaces the organization's Auto Router: whether it is enabled and its routes in order. Each route names an AI Gateway model from the options list, a description of when to use it, and one thinking level the model allows. The first route is the default model: its prompt is fixed (any prompt sent for it is ignored), Auto uses it when no other route matches, and it is the fallback when the router cannot decide. Every other route needs a prompt; enabling needs at least one route and is refused with auto_router_not_configured while the AI Gateway has no TypeSafe key. Requires the Manage Gateway providers permission, a recent sign-in and the Auto Router feature.",
      responses: {
        200: jsonResponse("Auto Router saved.", autoRouterSettingsSchema),
        400: jsonResponse("The request is invalid (for example a route other than the first has no prompt), a route names a model the AI Gateway does not offer, or a thinking level the model does not allow.", z.union([writeProblemSchema, invalidRequestSchema])),
        409: jsonResponse("Enabling was refused because the AI Gateway has no routing (TypeSafe) key.", notConfiguredSchema),
        401: unauthorized,
        403: jsonResponse("The caller lacks the Manage Gateway providers permission or needs to sign in again.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    requireOrgPermission("gateway_providers.manage"),
    jsonValidator(autoRouterWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const write = c.req.valid("json")
      if (write.enabled && await readAutoRouterRouting() === "missing_key") {
        return c.json({ error: "auto_router_not_configured" as const, message: AUTO_ROUTER_NOT_CONFIGURED_MESSAGE }, 409)
      }
      const problem = checkAutoRouterWrite(write, await listAutoRouterOptions(organizationId))
      if (problem) return c.json(problem, 400)
      await saveAutoRouter({ organizationId, memberId: payload.currentMember.id, write })
      return c.json(await settingsView(c, organizationId))
    },
  )

  app.get(
    "/v1/org/auto-router/connect",
    describeRoute(secretRoute({
      tags: ["Inference Providers"],
      summary: "Connect to Auto",
      description: "For desktops: when the organization's Auto Router is enabled and the caller can use at least one of its models, returns the OpenAI-compatible gateway base URL and the caller's own Gateway key so the desktop can offer Auto. Answers 404 otherwise, including while the AI Gateway has no TypeSafe key. Never returns provider secrets. Requires organization membership and the Auto Router feature.",
      responses: {
        200: jsonResponse("Connection returned.", autoRouterConnectSchema),
        401: unauthorized,
        404: jsonResponse("The Auto Router is off, not configured, or none of its models are available to the caller.", notFoundSchema),
      },
    })),
    orgMemberRoute(),
    requireFeature("autoRouter"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const router = await readAutoRouter(organizationId)
      if (!router.enabled || await readAutoRouterRouting() === "missing_key" || !await memberCanUseAutoRouter(organizationId, payload.currentMember.id, router.routes)) {
        return c.json({ error: "auto_router_unavailable" }, 404)
      }
      const apiKey = await ensureMemberGatewayKey({ organizationId, memberId: payload.currentMember.id })
      const response: AutoRouterConnect = {
        model: { id: AUTO_ROUTER_MODEL_ID, name: AUTO_ROUTER_MODEL_NAME },
        baseURL: gatewayBaseUrl(),
        apiKey,
      }
      return c.json(response)
    },
  )
}
