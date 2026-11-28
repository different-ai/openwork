import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, PluginTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { MCP_APP_LAUNCH_TOOL_NAME, mcpAppIdSchema, mcpAppPublicPath, mcpAppResourceUri, mcpAppRevisionIdSchema } from "@openwork/types/mcp-app"
import type { Context, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { changeMcpAppPublicSharing, listAccessibleMcpApps, McpAppError, mcpAppShareLink } from "../../mcp-apps.js"
import { jsonValidator, orgMemberRoute, paramValidator, resolveMemberTeamsMiddleware } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { connectMcpAppHostServerName, projectedMcpToolName } from "./mcp-connections.js"
import { PluginArchAuthorizationError, resolvePluginArchConfigObjectRoles } from "./plugin-system/access.js"
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
  isOwner: z.boolean().describe("Whether the calling member created this App. Display provenance only; not permission to edit or share."),
  canDelete: z.boolean().describe("Whether the calling member manages this App, which the delete route requires. The route still checks for itself."),
}).meta({ ref: "BuiltMcpApp" })

const builtMcpAppListResponseSchema = z.object({
  apps: z.array(builtMcpAppSchema),
}).meta({ ref: "BuiltMcpAppListResponse" })

const appParams = z.object({ appId: mcpAppIdSchema })
const shareLinkResponse = z.object({ url: z.url() }).meta({ ref: "McpAppShareLinkResponse" })
const publicSharingPath = "/v1/mcp-apps/:appId/public-sharing"
const publicSharingChange = z.object({
  public: z.boolean(),
  expectedRevisionId: mcpAppRevisionIdSchema,
}).strict().meta({ ref: "McpAppPublicSharingChange" })
const publicSharingResponse = z.object({
  revisionId: mcpAppRevisionIdSchema,
  publicUrl: z.url().nullable(),
  canPublish: z.boolean(),
  blockedBy: z.enum(["tools", "storage"]).nullable(),
}).meta({ ref: "McpAppPublicSharingResponse" })

const publicSharingError = z.object({ error: z.string(), message: z.string() })

function describePublicSharing(write: boolean) {
  return describeRoute({
    operationId: write ? "setBuiltMcpAppPublicSharing" : "getBuiltMcpAppPublicSharing",
    tags: ["Artifacts"],
    ...{ "x-mcp": false },
    summary: write ? "Change an artifact's public link" : "Read an artifact's public link settings",
    description: "Requires manager access to the artifact. Only artifacts with no bound tools and no saved data can be public; blockedBy names what prevents it. A public link allows anyone to open the artifact without signing in and does not grant access to the Plugin or connected data.",
    responses: {
      200: jsonResponse("Current public link settings.", publicSharingResponse),
      400: jsonResponse("Invalid artifact or request.", invalidRequestSchema),
      401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      403: jsonResponse("The caller must manage this artifact.", forbiddenSchema),
      404: jsonResponse("The artifact is unavailable.", notFoundSchema),
      ...(write ? {
        409: jsonResponse("The artifact has changed, uses tools, or saves data.", publicSharingError),
        422: jsonResponse("The revision failed its integrity check.", publicSharingError),
      } : {}),
    },
  })
}

async function publicSharing<T extends { Variables: OrgRouteVariables }>(
  c: Context<T>, appId: string, change?: z.infer<typeof publicSharingChange>,
) {
  c.header("Cache-Control", "no-store")
  try {
    const { revisionId, public: isPublic, canPublish, blockedBy } = await changeMcpAppPublicSharing({
      context: {
        organizationContext: c.get("organizationContext"),
        memberTeams: c.get("memberTeams") ?? [],
        session: c.get("session"),
      },
      appId,
      change,
    })
    const publicUrl = isPublic ? `${resolvePublicOrigin(c.req.raw, env.apiPublicUrl)}${mcpAppPublicPath(appId)}` : null
    return c.json({ revisionId, publicUrl, canPublish, blockedBy })
  } catch (error) {
    if (error instanceof McpAppError) return c.json({ error: error.code, message: error.message }, error.status)
    if (error instanceof PluginArchAuthorizationError) return c.json({ error: error.error, message: error.message }, error.status)
    throw error
  }
}

export function registerOrgMcpAppCatalogRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-apps/:appId/share-link",
    describeRoute({
      operationId: "getBuiltMcpAppShareLink",
      tags: ["Artifacts"],
      ...{ "x-mcp": false },
      summary: "Get an artifact's signed-in share link",
      description: "Requires access to open the artifact. The link does not grant access.",
      responses: {
        200: jsonResponse("Signed-in share link.", shareLinkResponse),
        400: jsonResponse("Invalid artifact.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be an organization member.", forbiddenSchema),
        404: jsonResponse("The artifact or feature is unavailable.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    requireFeature("artifactShareLinks"),
    paramValidator(appParams),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      try {
        return c.json(await mcpAppShareLink({
          organizationId: organization.id,
          member: { orgMembershipId: currentMember.id, teamIds: memberTeams.map((team) => team.id) },
          appId: c.req.valid("param").appId,
        }))
      } catch (error) {
        if (error instanceof McpAppError) return c.json({ error: error.code, message: error.message }, error.status)
        throw error
      }
    },
  )
  app.get(publicSharingPath, describePublicSharing(false), orgMemberRoute(), resolveMemberTeamsMiddleware,
    paramValidator(appParams), (c) => publicSharing(c, c.req.valid("param").appId))
  app.put(publicSharingPath, describePublicSharing(true), orgMemberRoute(), resolveMemberTeamsMiddleware,
    paramValidator(appParams), jsonValidator(publicSharingChange),
    (c) => publicSharing(c, c.req.valid("param").appId, c.req.valid("json")))
  app.get(
    "/v1/mcp-apps",
    describeRoute({
      tags: ["Artifacts"],
      summary: "List artifacts built in OpenWork",
      description: "Lists the artifacts built in OpenWork that the calling member can use, in the same element shape connection MCP Apps use, so OpenWork can list them in Artifacts. Each element opens the artifact through its own MCP server with open_app. Members see an App only when its Plugin is shared with them. Empty when Apps built in OpenWork are turned off.",
      responses: {
        200: jsonResponse("Artifacts the member can use.", builtMcpAppListResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller must be an organization member.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!env.appMcpServersEnabled) return c.json({ apps: [] })
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      const apps = await listAccessibleMcpApps({
        organizationId: payload.organization.id,
        member: { orgMembershipId: payload.currentMember.id, teamIds: memberTeams.map((team) => team.id) },
      })
      const pluginIds = [...new Set(apps.map((entry) => normalizeDenTypeId("plugin", entry.pluginId)))]
      const plugins = pluginIds.length === 0 ? [] : await db.select({ id: PluginTable.id, name: PluginTable.name })
        .from(PluginTable)
        .where(and(eq(PluginTable.organizationId, payload.organization.id), inArray(PluginTable.id, pluginIds)))
      const pluginNames = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
      const appIds = apps.map((entry) => normalizeDenTypeId("configObject", entry.appId))
      const owned = appIds.length === 0 ? [] : await db.select({ id: ConfigObjectTable.id })
        .from(ConfigObjectTable)
        .where(and(
          eq(ConfigObjectTable.organizationId, payload.organization.id),
          eq(ConfigObjectTable.createdByOrgMembershipId, payload.currentMember.id),
          inArray(ConfigObjectTable.id, appIds),
        ))
      const ownedIds = new Set(owned.map((entry) => entry.id))
      const roles = await resolvePluginArchConfigObjectRoles({ organizationContext: payload, memberTeams, session: c.get("session") }, appIds)
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
            isOwner: ownedIds.has(normalizeDenTypeId("configObject", entry.appId)),
            canDelete: roles.get(normalizeDenTypeId("configObject", entry.appId)) === "manager",
            requiresInput: false,
            requiredInputKeys: [],
            requiresApproval: false,
          }
        }),
      })
    },
  )
}
