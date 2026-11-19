import {
  PERSONAL_SKILLS_MAX_BYTES,
  personalSkillsBundleSchema,
  personalSkillsImportResponseSchema,
} from "@openwork/types/den/personal-skills"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, userSessionRoute, type OrganizationContextVariables } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { ensureFreshPrivilegedSession } from "../../privileged-session.js"
import type { AuthContextVariables } from "../../session.js"
import { PluginArchAuthorizationError } from "../org/plugin-system/access.js"
import { exportPersonalSkills, importPersonalSkills } from "../org/plugin-system/personal-skills.js"
import { PluginArchRouteFailure } from "../org/plugin-system/store.js"

type Variables = AuthContextVariables & Partial<OrganizationContextVariables>
const describePersonalSkillsRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const bundleSchema = personalSkillsBundleSchema.meta({ ref: "PersonalSkillsBundle" })
const resultSchema = personalSkillsImportResponseSchema.meta({ ref: "PersonalSkillsImportResponse" })

const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
}

const requireFreshSession: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
  const fresh = ensureFreshPrivilegedSession(c)
  if (!fresh.ok) return c.json(fresh.response, 403)
  await next()
}

async function withStoreErrors(c: Context, run: () => Promise<Response>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof PluginArchRouteFailure) return c.json({ error: error.error, message: error.message }, error.status)
    if (error instanceof PluginArchAuthorizationError) return c.json({ error: error.error, reason: error.reason, message: error.message }, 403)
    throw error
  }
}

export function registerMePersonalSkillsRoutes<T extends { Variables: Variables }>(app: Hono<T>) {
  const errors = {
    401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
    403: jsonResponse("A signed-in user session and the workspace's recent sign-in policy are required.", forbiddenSchema),
    404: jsonResponse("Workspace not found or private skill portability is off.", notFoundSchema),
    413: jsonResponse("The bundle is too large.", invalidRequestSchema),
  }
  app.get(
    "/v1/me/personal-skills/export",
    describePersonalSkillsRoute({
      tags: ["Users"],
      operationId: "exportMyPersonalSkills",
      "x-mcp": false,
      security: [{ bearerAuth: [] }],
      summary: "Export my private skills",
      description: "Downloads the latest SKILL.md source for the signed-in member’s own active, unshared, manually created skills in the current workspace.",
      responses: { 200: jsonResponse("The member's private skills bundle.", bundleSchema), ...errors },
    }),
    noStore,
    userSessionRoute(),
    orgMemberRoute(),
    requireFeature("personalSkillPortability"),
    requireFreshSession,
    async (c) => {
      const organizationContext = c.get("organizationContext")
      if (!organizationContext) return c.json({ error: "organization_not_found" }, 404)
      return withStoreErrors(c, async () => c.json(await exportPersonalSkills({ organizationContext, memberTeams: [], session: c.get("session") })))
    },
  )
  app.post(
    "/v1/me/personal-skills/import",
    describePersonalSkillsRoute({
      tags: ["Users"],
      operationId: "importMyPersonalSkills",
      "x-mcp": false,
      security: [{ bearerAuth: [] }],
      summary: "Import private copies of my skills",
      description: "Creates new private copies for the signed-in member in the current workspace. Every successful import creates fresh copies without overwriting or sharing anything.",
      responses: {
        200: jsonResponse("The number of new private copies created.", resultSchema),
        400: jsonResponse("The bundle or SKILL.md source was invalid.", invalidRequestSchema),
        ...errors,
      },
    }),
    noStore,
    userSessionRoute(),
    orgMemberRoute(),
    requireFeature("personalSkillPortability"),
    requireFreshSession,
    bodyLimit({ maxSize: PERSONAL_SKILLS_MAX_BYTES, onError: (c) => c.json({ error: "personal_skills_bundle_too_large", message: "The private skills bundle must fit within 8 MiB." }, 413) }),
    jsonValidator(bundleSchema),
    async (c) => {
      const organizationContext = c.get("organizationContext")
      if (!organizationContext) return c.json({ error: "organization_not_found" }, 404)
      return withStoreErrors(c, async () => c.json(await importPersonalSkills({ organizationContext, memberTeams: [], session: c.get("session") }, c.req.valid("json"))))
    },
  )
}
