import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { paramValidator, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { graphError, graphErrorStatus, needsConnectionSchema, pagingDescription, upstreamErrorSchema, type Microsoft365Access } from "./microsoft-365-shared.js"
import { MICROSOFT_GRAPH_RESOURCE_PREFIX, microsoftGraphResources } from "./microsoft-graph-resources.js"
import { microsoftGraphResourceSchemas, readMicrosoftGraphResource } from "./microsoft-graph-resource-reader.js"
import type { OrgRouteVariables } from "./shared.js"

const policyBlockedSchema = z.object({ error: z.literal("policy_blocked"), message: z.string() })

export function registerMicrosoftGraphResourceRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  { access, memberRoute }: { access: Microsoft365Access; memberRoute: MiddlewareHandler<{ Variables: OrgRouteVariables }> },
) {
  for (const row of microsoftGraphResources) {
    const schemas = microsoftGraphResourceSchemas(row)
    app.get(
      `${MICROSOFT_GRAPH_RESOURCE_PREFIX}${row.route}`,
      describeRoute({
        operationId: row.operationId,
        tags: ["Capability Sources"],
        summary: row.summary,
        description: row.output.kind === "list" ? `${row.description} ${pagingDescription}` : row.description,
        responses: {
          200: jsonResponse("Microsoft 365 data returned.", schemas.response),
          400: jsonResponse("A request parameter is invalid.", invalidRequestSchema),
          401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
          403: jsonResponse("The connection is blocked by organization policy.", policyBlockedSchema),
          404: jsonResponse("This Microsoft 365 resource is disabled.", z.object({ error: z.literal("feature_disabled"), feature: z.literal(row.flag) })),
          409: jsonResponse("The calling member has not connected Microsoft 365 or is missing permission.", needsConnectionSchema),
          502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
        },
      }),
      memberRoute,
      requireFeature(row.flag),
      paramValidator(schemas.params),
      queryValidator(schemas.query),
      async (c) => {
        const { organization, currentMember } = c.get("organizationContext")
        const permission = row.permission === "connection" ? { features: [], label: "Microsoft 365 profile" } : row.permission
        const granted = await access({ organizationId: organization.id, orgMembershipId: currentMember.id, ...permission })
        if (!granted.ok) return c.json(granted.body, granted.status)
        try {
          return c.json(await readMicrosoftGraphResource(granted.graph({ signal: c.req.raw.signal }), row, c.req.valid("param"), c.req.valid("query")))
        } catch (error) {
          return c.json(graphError(error), graphErrorStatus(error))
        }
      },
    )
  }
}
