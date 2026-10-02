import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { PluginTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { MCP_APP_LAUNCH_TOOL_NAME, mcpAppResourceUri } from "@openwork/types/mcp-app"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { appMcpServersEnabled } from "../../mcp-app-rollout.js"
import { listAccessibleMcpApps } from "../../mcp-apps.js"
import { orgRoleRoute, resolveMemberTeamsMiddleware } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { connectMcpAppHostServerName, projectedMcpToolName } from "./mcp-connections.js"
import type { OrgRouteVariables } from "./shared.js"

const builtMcpAppSchema = z.object({
  serverName: z.string(),
  connectionId: z.string(),
  toolName: z.string(),
  projectedToolName: z.string(),
  resourceUri: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  pluginId: z.string(),
  pluginName: z.string(),
  requiresInput: z.boolean(),
  requiredInputKeys: z.array(z.string()),
  requiresApproval: z.boolean(),
}).meta({ ref: "BuiltMcpApp" })

const builtMcpAppListResponseSchema = z.object({
  apps: z.array(builtMcpAppSchema),
}).meta({ ref: "BuiltMcpAppListResponse" })

/**
 * Apps built in OpenWork that the signed-in member can put on a personal Dashboard,
 * in the same element shape connection MCP Apps use. Each element opens the
 * App through its own MCP server, where the desktop finds it by App id.
 */
export function registerOrgMcpAppCatalogRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-apps",
    describeRoute({
      tags: ["Dashboards"],
      summary: "List Apps built in OpenWork for dashboards",
      description: "Lists the Apps built in OpenWork that the calling member can use, in the element shape organization Dashboards store. Each element opens the App through its own MCP server with open_app, and Dashboards keep it on the App's current revision. Members see a tile only when the App's Plugin is shared with them. Empty when Apps built in OpenWork are turned off. Only Apps the member can access are listed.",
      responses: {
        200: jsonResponse("Apps built in OpenWork that can be added to a dashboard.", builtMcpAppListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be an organization member.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["member"]),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!appMcpServersEnabled(payload.organization.metadata)) return c.json({ apps: [] })
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const apps = await listAccessibleMcpApps({
        organizationId: payload.organization.id,
        member: { orgMembershipId: payload.currentMember.id, teamIds: memberTeams.map((team) => team.id) },
        enabled: true,
      })
      const pluginIds = [...new Set(apps.map((entry) => normalizeDenTypeId("plugin", entry.pluginId)))]
      const plugins = pluginIds.length === 0 ? [] : await db.select({ id: PluginTable.id, name: PluginTable.name })
        .from(PluginTable)
        .where(and(eq(PluginTable.organizationId, payload.organization.id), inArray(PluginTable.id, pluginIds)))
      const pluginNames = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
      return c.json({
        apps: apps.map((entry) => {
          const serverName = connectMcpAppHostServerName(entry.appId)
          return {
            serverName,
            connectionId: entry.appId,
            toolName: MCP_APP_LAUNCH_TOOL_NAME,
            projectedToolName: projectedMcpToolName(serverName, MCP_APP_LAUNCH_TOOL_NAME),
            resourceUri: mcpAppResourceUri(entry.appId, entry.revisionId),
            title: entry.title,
            description: entry.description,
            pluginId: entry.pluginId,
            pluginName: pluginNames.get(normalizeDenTypeId("plugin", entry.pluginId)) ?? entry.title,
            // open_app takes only optional launch input and runs no other tools.
            requiresInput: false,
            requiredInputKeys: [],
            requiresApproval: false,
          }
        }),
      })
    },
  )
}
