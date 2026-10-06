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
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import { mintHeadlessRunMcpToken } from "../mcp/headless-run-token-mint.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import { jsonResponse, unauthorizedSchema } from "../openapi.js"
import { organizationFeatureEnabled } from "../features.js"
import { jsonValidator, tokenRoute } from "../middleware/index.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import { getOrganizationContextForUser, listTeamsForMember } from "../orgs.js"
import { listMemberUsableConnectionFacts } from "../routes/org/mcp-connections.js"

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
  scopes: Set<string>
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

const workbotConnectionsSchema = z.object({
  connections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    app: z.enum(["gmail", "slack", "microsoft"]),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
  })),
})

/** Which everyday app a connection is, for Workbot's welcome: Gmail (or Google Workspace), Slack, or Microsoft 365. */
function everydayApp(fact: { name: string; url: string; nativeProviderKey: string | null }): "gmail" | "slack" | "microsoft" | null {
  const key = fact.nativeProviderKey?.toLowerCase() ?? ""
  const text = `${fact.name} ${fact.url}`.toLowerCase()
  if (key.includes("google") || /gmail|google workspace/.test(text)) return "gmail"
  if (key.includes("microsoft") || /microsoft|outlook|office ?365|m365/.test(text)) return "microsoft"
  if (/slack/.test(text)) return "slack"
  return null
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
    scopes: verified.scopes,
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
        enabled: await organizationFeatureEnabled(organization.id, "workbot"),
        canSchedule,
      })
    },
  )

  app.get(
    "/v1/workbot/connections",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "listWorkbotConnections",
      "x-mcp": false,
      summary: "The everyday apps the person can connect for Workbot",
      description:
        "For the Workbot app only. The Gmail or Google Workspace, Slack and Microsoft 365 connections the organization's admins set up and this member may use, with whether each is ready for them, and where in Den they connect their own account.",
      responses: {
        200: jsonResponse("The connections.", workbotConnectionsSchema),
        401: jsonResponse("The token is missing, expired or revoked, or the membership ended.", unauthorizedSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const organizationContext = await getOrganizationContextForUser({ userId: normalizeDenTypeId("user", resolved.principal.userId), organizationId: resolved.organization.id })
      if (!organizationContext) return c.json({ connections: [] })
      const memberTeams = await listTeamsForMember({ organizationId: resolved.organization.id, memberId: normalizeDenTypeId("member", resolved.memberId) })
      const facts = await listMemberUsableConnectionFacts({ context: { organizationContext, memberTeams, session: null } })
      const connections = facts.flatMap((fact) => {
        const app = everydayApp(fact)
        if (!app) return []
        // Set up by an admin but not finished there: not something the member can do anything about yet.
        if (fact.setupRequired === true) return []
        const ready = fact.connectedForMe && !fact.needsReconnect
        return [{ id: fact.id, name: fact.name, app, ready, connectUrl: ready ? null : openworkYourConnectionsUrl(fact.id) }]
      })
      return c.json({ connections })
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
        403: jsonResponse("Workbot is off or the sign-in grant cannot start a turn.", signedOutSchema),
        429: jsonResponse("Too many tokens requested.", z.object({ error: z.literal("rate_limited"), retryAfter: z.number() })),
      },
    }),
    tokenRoute,
    jsonValidator(z.object({ ttlMs: z.number().int().min(60_000).max(DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS).optional(), readOnly: z.boolean().optional() })),
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const { principal, organization } = resolved
      const readOnly = c.req.valid("json").readOnly === true
      const requiredScopes = readOnly ? [DEN_MCP_READ_SCOPE] : [DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE]
      if (requiredScopes.some((scope) => !resolved.scopes.has(scope))) {
        return c.json({ error: "insufficient_scope", message: "The sign-in grant does not allow this Workbot turn." }, 403)
      }
      if (!(await organizationFeatureEnabled(organization.id, "workbot"))) {
        return c.json({ error: "workbot_not_enabled", message: "Workbot is off for this workspace." }, 403)
      }
      const retryAfter = await checkRateLimit(`workbot-run-token:${principal.organizationId}:${principal.userId}`, RUN_TOKENS_PER_WINDOW, RUN_TOKEN_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
      const ttlMs = c.req.valid("json").ttlMs ?? DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS
      const { token } = await mintHeadlessRunMcpToken({ ...principal, ttlMs, readOnly })
      return c.json({ token, expiresAt: new Date(Date.now() + ttlMs).toISOString() })
    },
  )
}
