import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { McpAppError } from "../../mcp-apps.js"
import { jsonValidator, orgRoleRoute, paramValidator, resolveMemberTeamsMiddleware } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { MemberTeamSummary } from "../../orgs.js"
import { listPublicMcpApps, publishMcpApp, unpublishMcpApp } from "../../public-mcp-apps.js"
import { PluginArchAuthorizationError } from "./plugin-system/access.js"
import { idParamSchema, type OrgRouteVariables } from "./shared.js"

const publicAppSchema = z.object({
  publicationId: z.string().describe("Stable id of the public App. Publishing the App again keeps it."),
  slug: z.string().describe("The App's name in its public URL, unique across this deployment."),
  appId: z.string(),
  revisionId: z.string().describe("The App revision visitors see. Later updates stay private until the App is published again."),
  title: z.string(),
  url: z.string().describe("Public MCP URL anyone can add to an MCP client without signing in."),
  publishedAt: z.string().datetime(),
}).meta({ ref: "PublicApp" })

const publicAppListSchema = z.object({ apps: z.array(publicAppSchema) }).meta({ ref: "PublicAppList" })
const publicAppConflictSchema = z.object({ error: z.string(), message: z.string() }).meta({ ref: "PublicAppConflict" })
const appParamsSchema = idParamSchema("appId", "configObject")
const publishBodySchema = z.object({
  slug: z.string().trim().toLowerCase().min(3).max(48).optional()
    .describe("Name in the public URL, such as coffee-with-the-team: 3 to 48 lowercase letters, digits and single hyphens, not starting with openwork. Defaults to the App's current slug, then one made from its title. Choosing a new one stops the old URL."),
}).strict().meta({ ref: "PublishPublicAppRequest" })

const unauthorized = jsonResponse("Authentication required.", unauthorizedSchema)
const adminForbidden = jsonResponse("Only organization owners and admins can publish Apps, and the caller must be able to edit the App.", forbiddenSchema)
const notFound = jsonResponse("The organization or App was not found, or publishing Apps is turned off.", notFoundSchema)

const ADMIN = orgRoleRoute(["admin"])

function origin(request: Request): string {
  return resolvePublicOrigin(request, env.apiPublicUrl)
}

/**
 * Public Apps: an owner or admin publishes an App built in OpenWork at a
 * public MCP URL that needs no sign-in. Behind the `publicApps` feature.
 */
export function registerOrgPublicAppRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/public-apps",
    describeRoute({
      tags: ["Apps"],
      summary: "List public Apps",
      description: "Lists the organization's Apps that are published at a public MCP URL, newest first. Requires an organization owner or admin and the public Apps feature.",
      responses: { 200: jsonResponse("Public Apps.", publicAppListSchema), 401: unauthorized, 403: adminForbidden, 404: notFound },
    }),
    ADMIN,
    requireFeature("publicApps"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      return c.json({ apps: await listPublicMcpApps({ organizationId, origin: origin(c.req.raw) }) })
    },
  )

  app.put(
    "/v1/public-apps/:appId",
    describeRoute({
      tags: ["Apps"],
      summary: "Publish an App publicly",
      description: "Publishes the App's current revision at a public MCP URL, /mcp/public/apps/{slug}, that anyone can add to an MCP client without signing in to OpenWork, or pins its newest revision when it is already public. The URL stays the same unless a new slug is chosen; a slug stays with its App even while unpublished. Only Apps without tools can be published; visitors see the App and nothing else from OpenWork. It stops being served when the App is deleted or the feature is turned off. Requires an organization owner or admin who can edit the App, and the public Apps feature.",
      responses: {
        200: jsonResponse("The App is public.", publicAppSchema),
        400: jsonResponse("The App id or slug is invalid.", invalidRequestSchema),
        401: unauthorized,
        403: adminForbidden,
        404: notFound,
        409: jsonResponse("The App declares tools, so it cannot be published publicly yet, or another App already uses the slug.", publicAppConflictSchema),
      },
    }),
    ADMIN,
    requireFeature("publicApps"),
    resolveMemberTeamsMiddleware,
    paramValidator(appParamsSchema),
    jsonValidator(publishBodySchema),
    async (c) => {
      const memberTeams: MemberTeamSummary[] = c.get("memberTeams") ?? []
      try {
        const published = await publishMcpApp({
          context: { organizationContext: c.get("organizationContext"), memberTeams, session: c.get("session") },
          appId: c.req.valid("param").appId,
          slug: c.req.valid("json").slug,
          origin: origin(c.req.raw),
        })
        return c.json(published)
      } catch (error) {
        if (error instanceof PluginArchAuthorizationError) return c.json({ error: error.error, message: error.message }, 403)
        if (error instanceof McpAppError) {
          if (error.status === 409) return c.json({ error: error.code, message: error.message }, 409)
          if (error.status === 400) return c.json({ error: "invalid_request", message: error.message, details: [] }, 400)
          return c.json({ error: "app_not_found", message: "The App is not available." }, 404)
        }
        throw error
      }
    },
  )

  app.delete(
    "/v1/public-apps/:appId",
    describeRoute({
      tags: ["Apps"],
      summary: "Stop publishing an App publicly",
      description: "Stops serving the App at its public MCP URL right away. Visitors' clients get \"This App is not available.\" until the App is published again, which brings back the same URL. The App itself is unchanged. Requires an organization owner or admin and the public Apps feature.",
      responses: {
        200: jsonResponse("The App is no longer public.", publicAppListSchema),
        400: jsonResponse("The App id is invalid.", invalidRequestSchema),
        401: unauthorized,
        403: adminForbidden,
        404: notFound,
      },
    }),
    ADMIN,
    requireFeature("publicApps"),
    paramValidator(appParamsSchema),
    async (c) => {
      const organizationId = c.get("organizationContext").organization.id
      if (!await unpublishMcpApp({ organizationId, appId: c.req.valid("param").appId })) {
        return c.json({ error: "public_app_not_found", message: "The App is not public." }, 404)
      }
      return c.json({ apps: await listPublicMcpApps({ organizationId, origin: origin(c.req.raw) }) })
    },
  )
}
