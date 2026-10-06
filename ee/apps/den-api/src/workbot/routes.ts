import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { DEN_MCP_OAUTH_RESOURCE } from "../auth.js"
import { cloudAutomationRuntime } from "../automations/headless-runtime.js"
import { db } from "../db.js"
import { verifyMcpRequest } from "../mcp/auth.js"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../infra/headless-runner/run-token.js"
import { mintHeadlessRunMcpToken } from "../infra/headless-runner/run-token-mint.js"
import { jsonResponse, unauthorizedSchema } from "../openapi.js"
import { organizationHasCapability } from "../organization-capabilities.js"
import { jsonValidator, tokenRoute } from "../middleware/index.js"
import { checkRateLimit } from "../utils/rate-limit.js"

/**
 * What Den tells the Workbot app (ee/apps/workbot) about a signed-in person. Workbot calls these server-to-server
 * with the access token it got when the person signed in through Den (an OAuth token for `/mcp/agent`), so Den stays
 * the one place that decides who may use Workbot and what its turns can reach. Nothing else in Den accepts these
 * tokens on a REST route.
 */
type WorkbotRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeWorkbotRoute = (options: WorkbotRouteOptions) => describeRoute(options)

const sessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string() }),
  organization: z.object({ id: z.string(), name: z.string(), brandAppName: z.string().nullable() }),
  memberId: z.string(),
  /** A platform admin turned Workbot on for this organization. */
  enabled: z.boolean(),
  /** Workbot may set up recurring work: the organization runs Automations on the headless runner. */
  canSchedule: z.boolean(),
}).meta({ ref: "WorkbotSession" })

const runTokenSchema = z.object({ token: z.string(), expiresAt: z.iso.datetime() }).meta({ ref: "WorkbotRunToken" })
const signedOutSchema = z.object({ error: z.string(), message: z.string().optional() })

/** Plenty for one person's turns (each send and resume needs one); stops a runaway client minting in a loop. */
const RUN_TOKENS_PER_WINDOW = 120
const RUN_TOKEN_WINDOW_MS = 10 * 60_000

type Principal = { userId: string; organizationId: string }
type Resolved = {
  principal: Principal
  user: { id: string; name: string | null; email: string }
  organization: Pick<typeof OrganizationTable.$inferSelect, "id" | "name" | "metadata">
  memberId: string
}

function readBrandAppName(metadata: unknown): string | null {
  const parsed = typeof metadata === "string" ? safeJson(metadata) : metadata
  if (typeof parsed !== "object" || parsed === null || !("brandAppName" in parsed)) return null
  const brand = parsed.brandAppName
  return typeof brand === "string" && brand.trim() ? brand.trim() : null
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The person behind a Workbot access token: a live Den grant, an active member of the token's organization. */
async function resolve(headers: Headers): Promise<Resolved | Response> {
  const verified = await verifyMcpRequest(headers, DEN_MCP_OAUTH_RESOURCE)
  if (verified instanceof Response) return verified
  const userId = normalizeDenTypeId("user", verified.userId)
  const organizationId = normalizeDenTypeId("organization", verified.organizationId)
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
    .limit(1)
  const [organization] = await db
    .select({ id: OrganizationTable.id, name: OrganizationTable.name, metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  const [user] = await db
    .select({ id: AuthUserTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)
  if (!member || !organization || !user) {
    return Response.json({ error: "membership_revoked", message: "This account is no longer a member of the workspace." }, { status: 401 })
  }
  return {
    principal: { userId, organizationId },
    user: { id: user.id, name: user.name?.trim() || null, email: user.email },
    organization,
    memberId: member.id,
  }
}

export function registerWorkbotRoutes<T extends { Variables: object }>(app: Hono<T>) {
  app.get(
    "/v1/workbot/session",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "getWorkbotSession",
      "x-mcp": false,
      summary: "Who is signed in to Workbot",
      description:
        "For the Workbot app only. With the access token a person got by signing in to Workbot through Den, returns who they are, the workspace they chose, and whether Workbot is on for it.",
      responses: {
        200: jsonResponse("The signed-in person and their workspace.", sessionSchema),
        401: jsonResponse("The token is missing, expired or revoked, or the membership ended.", unauthorizedSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const { organization, user, memberId } = resolved
      const canSchedule = (await cloudAutomationRuntime(organization.id).catch(() => "web")) === "headless"
      return c.json({
        user,
        organization: { id: organization.id, name: organization.name, brandAppName: readBrandAppName(organization.metadata) },
        memberId,
        enabled: organizationHasCapability(organization.metadata, "workbot"),
        canSchedule,
      })
    },
  )

  app.post(
    "/v1/workbot/run-token",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "createWorkbotRunToken",
      "x-mcp": false,
      summary: "A short-lived token for one Workbot turn",
      description:
        "For the Workbot app only. Mints the member-scoped MCP token a Workbot turn uses to reach the person's connected apps on the headless runner, for at most an hour. Refused when Workbot is off for the workspace.",
      responses: {
        200: jsonResponse("The token.", runTokenSchema),
        401: jsonResponse("The token is missing, expired or revoked, or the membership ended.", unauthorizedSchema),
        403: jsonResponse("Workbot is off for this workspace.", signedOutSchema),
        429: jsonResponse("Too many tokens requested.", z.object({ error: z.literal("rate_limited"), retryAfter: z.number() })),
      },
    }),
    tokenRoute,
    jsonValidator(z.object({ ttlMs: z.number().int().min(60_000).max(DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS).optional() })),
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const { principal, organization } = resolved
      if (!organizationHasCapability(organization.metadata, "workbot")) {
        return c.json({ error: "workbot_not_enabled", message: "Workbot is off for this workspace." }, 403)
      }
      const retryAfter = await checkRateLimit(`workbot-run-token:${principal.organizationId}:${principal.userId}`, RUN_TOKENS_PER_WINDOW, RUN_TOKEN_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
      const ttlMs = c.req.valid("json").ttlMs ?? DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS
      const { token } = await mintHeadlessRunMcpToken({ ...principal, ttlMs })
      return c.json({ token, expiresAt: new Date(Date.now() + ttlMs).toISOString() })
    },
  )
}
