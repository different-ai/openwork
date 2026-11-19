import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError } from "../../agent-error-envelope.js"
import { listActivePluginArchIds, readDashboardActivity, type DashboardActivityAccess } from "../../dashboard-activity.js"
import { DASHBOARD_ACTIVITY_LIMIT } from "../../dashboard-activity-rows.js"
import { gatewayManagementUnavailable } from "../../gateway-deployment.js"
import { orgMemberRoute, resolveMemberTeamsMiddleware, verifyOrgRole } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { canManageAllPluginArchResources, resolvePluginArchPluginRoles, resolvePluginArchResourceRole, type PluginArchActorContext } from "./plugin-system/access.js"
import { memberPermissionsForRequest, type OrgRouteVariables } from "./shared.js"

const logoSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  providerId: z.string().optional(),
})

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connection"), connectionId: z.string() }),
  z.object({ type: z.literal("llm_provider"), llmProviderId: z.string() }),
  z.object({ type: z.literal("gateway_provider"), inferenceProviderId: z.string() }),
  z.object({ type: z.literal("marketplace"), marketplaceId: z.string() }),
  z.object({ type: z.literal("skill"), pluginId: z.string(), skillId: z.string() }),
]).meta({ ref: "DashboardActivityTarget" })

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["connection", "skill", "plugin", "provider"]),
  title: z.string(),
  detail: z.string(),
  occurredAt: z.string().datetime(),
  target: targetSchema,
  logo: logoSchema.optional(),
}).meta({ ref: "DashboardActivityEntry" })

export const dashboardActivityResponseSchema = z.object({
  activity: z.array(entrySchema).max(DASHBOARD_ACTIVITY_LIMIT),
}).meta({ ref: "DashboardActivity" })


export function registerOrgActivityRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/activity",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get recent dashboard activity",
      description: [
        "Returns the organization's five newest additions for the admin dashboard, newest first (ties by event id): connections and model providers by their stored creation time, plugins added to an active marketplace (excluding the built-in catalog) by the attachment's creation time, and published versions of active skills in active plugins.",
        "A snapshot of existing resources, not an audit log: removed or archived resources do not contribute. Each source follows the permission of its own admin list (View all connections, View all providers, View Gateway providers on a Gateway-enabled deployment, Manage everything shared or the caller's plugin and marketplace access).",
        "Workspace owners and admins only.",
      ].join(" "),
      responses: {
        200: jsonResponse("The newest dashboard activity.", dashboardActivityResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can read dashboard activity.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const organizationContext = c.get("organizationContext")
      if (!verifyOrgRole({ roles: ["admin"], userContext: organizationContext.currentMember })) {
        c.header("WWW-Authenticate", INSUFFICIENT_SCOPE_CHALLENGE)
        return c.json({
          error: "forbidden",
          ...requiresAdminError("Only workspace owners and admins can do this. Ask one of them, or have them change your role."),
        }, 403)
      }
      const permissions = await memberPermissionsForRequest(c)
      const memberPermissions = permissions ?? undefined
      const context: PluginArchActorContext = {
        ...(c.get("apiKey") ? { apiKey: true } : {}),
        ...(memberPermissions ? { memberPermissions } : {}),
        memberTeams: c.get("memberTeams") ?? [],
        organizationContext,
        session: c.get("session"),
      }
      const organizationId = organizationContext.organization.id
      let plugins: DashboardActivityAccess["plugins"] = "all"
      let marketplaces: DashboardActivityAccess["marketplaces"] = "all"
      if (!(await canManageAllPluginArchResources(context))) {
        // Rare: an admin without Manage everything shared sees what was shared with them.
        const ids = await listActivePluginArchIds(organizationId)
        plugins = [...(await resolvePluginArchPluginRoles(context, ids.pluginIds)).keys()]
        const roles = await Promise.all(ids.marketplaceIds.map(async (marketplaceId) =>
          (await resolvePluginArchResourceRole({ context, resourceId: marketplaceId, resourceKind: "marketplace" })) ? marketplaceId : null))
        marketplaces = roles.filter((marketplaceId) => marketplaceId !== null)
      }
      const activity = await readDashboardActivity({
        organizationId,
        memberId: organizationContext.currentMember.id,
        access: {
          connections: permissions?.has("connections.view") ?? false,
          allLlmProviders: permissions?.has("llm_providers.view") ?? false,
          gatewayProviders: (permissions?.has("gateway_providers.view") ?? false) && gatewayManagementUnavailable() === null,
          plugins,
          marketplaces,
        },
      })
      c.header("Cache-Control", "no-store")
      return c.json({ activity })
    },
  )
}
