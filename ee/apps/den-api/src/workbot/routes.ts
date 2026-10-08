import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Context, Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { DEN_MCP_OAUTH_RESOURCE } from "../auth.js"
import { cloudAutomationRuntime } from "../automations/headless-runtime.js"
import { db } from "../db.js"
import { attributeAuditRequest, auditUserPrincipalKey } from "../audit/request-capture.js"
import { mcpPrincipalCredentialId, verifyMcpRequest } from "../mcp/auth.js"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import { mintHeadlessRunMcpToken } from "../mcp/headless-run-token-mint.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import { jsonResponse, unauthorizedSchema } from "../openapi.js"
import { getOrganizationFeatures, organizationFeatureEnabled } from "../features.js"
import { jsonValidator, tokenRoute } from "../middleware/index.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import { createInternalMcpPrincipalHeader } from "../session.js"
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
  /** Workbot shows its Calendar tab: Workbot and the workbotCalendar feature are on. Older Dens omit it. */
  calendar: z.boolean().optional(),
  /** The person can start side chats next to their main chat (the workbotSideChats feature). */
  sideChats: z.boolean(),
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
  /** MCP grant/client id of the Workbot token (never token material). */
  credentialId: string | null
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
    credentialId: mcpPrincipalCredentialId(verified),
  }
}

/** Verified Workbot token + active membership: the token's organization and member are the audit tenant/actor. */
async function attributeWorkbot(c: Context, resolved: Resolved) {
  const credentialId = resolved.credentialId
  const audited = await attributeAuditRequest(c, {
    organizationId: resolved.organization.id,
    actor: { type: "user", id: resolved.user.id, memberId: resolved.memberId, ...(credentialId ? { credentialId } : {}) },
    principalKey: auditUserPrincipalKey({ userId: resolved.user.id, memberId: resolved.memberId, credentialId: `mcp:${credentialId ?? "token"}` }),
  })
  return audited.ok ? null : audited.response
}

async function workbotCalendarEnabled(organizationId: string) {
  return await organizationFeatureEnabled(organizationId, "workbot") && await organizationFeatureEnabled(organizationId, "workbotCalendar")
}

const ID = "[A-Za-z0-9_-]{1,160}"
/**
 * The Den routes Workbot's Calendar may reach, as the signed-in member: their own Automations and runs, the
 * Pause / Resume / Run now actions, editing an Automation's schedule, instructions or model, creating a Cloud
 * Automation, the models they may pick (names only), and their native Google and Outlook calendar reads.
 * Nothing else is forwarded.
 */
const WORKBOT_CALENDAR_ROUTES: ReadonlyArray<{ method: "GET" | "POST" | "PATCH"; path: RegExp; write: boolean }> = [
  { method: "GET", path: /^\/v1\/automations$/, write: false },
  { method: "GET", path: /^\/v1\/automation-runs$/, write: false },
  { method: "GET", path: new RegExp(`^/v1/automations/${ID}/runs$`), write: false },
  { method: "GET", path: new RegExp(`^/v1/automation-runs/${ID}$`), write: false },
  { method: "GET", path: /^\/v1\/capabilities\/(google-workspace|microsoft-365)\/calendar-events$/, write: false },
  // The models the member may pick, trimmed below to names and IDs.
  { method: "GET", path: /^\/v1\/llm-providers$/, write: false },
  { method: "POST", path: new RegExp(`^/v1/automations/${ID}/(activate|deactivate|run)$`), write: true },
  // Creating from the Calendar: always a Cloud Automation (Workbot has no desktop), validated by the route itself.
  { method: "POST", path: /^\/v1\/cloud-automations$/, write: true },
  { method: "PATCH", path: new RegExp(`^/v1/automations/${ID}$`), write: true },
]
export const WORKBOT_CALENDAR_PREFIX = "/v1/workbot/calendar"

/**
 * What Workbot's Calendar may change: the schedule, name, instructions and model. Never where it runs (Workbot
 * has no desktop) or its action; the destination route validates each value.
 */
const calendarEditSchema = z.object({
  name: z.unknown().optional(),
  schedule: z.unknown().optional(),
  instructions: z.unknown().optional(),
  model: z.unknown().optional(),
}).strict().refine((value) => Object.keys(value).length > 0)

/** A usable provider as Workbot's model picker needs it: no configuration, keys or access lists. */
const providerNamesSchema = z.object({
  llmProviders: z.array(z.object({
    id: z.string(),
    source: z.string(),
    providerId: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
})

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
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
      const { organization, user, memberId } = resolved
      const canSchedule = (await cloudAutomationRuntime(organization.id).catch(() => "web")) === "headless"
      const features = await getOrganizationFeatures(organization.id)
      return c.json({
        user,
        organization: { id: organization.id, name: organization.name, brandAppName: readBrandAppName(organization.metadata) },
        memberId,
        enabled: features.workbot,
        canSchedule,
        calendar: features.workbot && features.workbotCalendar,
        sideChats: features.workbot && features.workbotSideChats,
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
        403: jsonResponse("Workbot is off for this workspace.", signedOutSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      if (!(await organizationFeatureEnabled(resolved.organization.id, "workbot"))) {
        return c.json({ error: "workbot_not_enabled", message: "Workbot is off for this workspace." }, 403)
      }
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

  app.on(
    ["GET", "POST", "PATCH"],
    `${WORKBOT_CALENDAR_PREFIX}/*`,
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "workbotCalendarProxy",
      "x-mcp": false,
      summary: "Workbot's Calendar: the member's Automations, runs and calendar meetings",
      description:
        "For the Workbot app only. Forwards an allowlisted Den route, as the member behind the Workbot token: GET /v1/automations, GET /v1/automation-runs, GET /v1/automations/{id}/runs, GET /v1/automation-runs/{id}, GET /v1/capabilities/{google-workspace|microsoft-365}/calendar-events, GET /v1/llm-providers (names and model IDs only), POST /v1/automations/{id}/{activate|deactivate|run}, POST /v1/cloud-automations and a PATCH /v1/automations/{id} limited to name, schedule, instructions and model. Refused while Workbot or its Calendar is off.",
      responses: {
        200: jsonResponse("The forwarded route's answer.", z.unknown()),
        401: jsonResponse("The token is missing, expired or revoked, or the membership ended.", unauthorizedSchema),
        403: jsonResponse("Workbot's Calendar is off, or the sign-in grant cannot make this change.", signedOutSchema),
        404: jsonResponse("Not a route Workbot's Calendar may reach.", signedOutSchema),
      },
    }),
    tokenRoute,
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
      const url = new URL(c.req.url)
      const inner = url.pathname.slice(WORKBOT_CALENDAR_PREFIX.length)
      const method = c.req.method
      const route = WORKBOT_CALENDAR_ROUTES.find((entry) => entry.method === method && entry.path.test(inner))
      if (!route) return c.json({ error: "not_found", message: "Workbot's Calendar cannot reach this route." }, 404)
      if (!(await workbotCalendarEnabled(resolved.organization.id))) {
        return c.json({ error: "workbot_calendar_not_enabled", message: "Workbot's Calendar is off for this workspace." }, 403)
      }
      const scope = route.write ? DEN_MCP_WRITE_SCOPE : DEN_MCP_READ_SCOPE
      if (!resolved.scopes.has(scope)) return c.json({ error: "insufficient_scope", message: "The sign-in grant does not allow this." }, 403)
      let body: string | undefined
      if (method === "PATCH") {
        const parsed = calendarEditSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: "invalid_request", message: "Only the schedule, name, instructions and model can change here." }, 400)
        body = JSON.stringify(parsed.data)
      } else if (method === "POST" && inner === "/v1/cloud-automations") {
        const parsed = z.record(z.string(), z.unknown()).safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: "invalid_request", message: "Send the new Automation as JSON." }, 400)
        body = JSON.stringify(parsed.data)
      } else if (method === "POST") {
        body = "{}"
      }
      const headers = new Headers({
        accept: "application/json",
        "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({
          userId: resolved.principal.userId,
          organizationId: resolved.principal.organizationId,
          credentialId: resolved.credentialId,
        }),
      })
      if (body !== undefined) headers.set("content-type", "application/json")
      const response = await app.fetch(new Request(new URL(`${inner}${url.search}`, "http://den-api.local"), { method, headers, body }))
      const payload: unknown = await response.json().catch(() => null)
      if (inner === "/v1/llm-providers" && response.ok) {
        const names = providerNamesSchema.safeParse(payload)
        return c.json(names.success ? { llmProviders: names.data.llmProviders } : { llmProviders: [] }, 200)
      }
      return new Response(JSON.stringify(payload), { status: response.status, headers: { "content-type": "application/json" } })
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
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
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
