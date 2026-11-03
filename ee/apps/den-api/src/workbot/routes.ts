import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Context, Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { bodyLimit } from "hono/body-limit"
import { DEN_MCP_OAUTH_RESOURCE } from "../auth.js"
import { cloudAutomationRuntime } from "../automations/headless-runtime.js"
import { db } from "../db.js"
import { attributeAuditRequest, auditUserPrincipalKey } from "../audit/request-capture.js"
import { mcpPrincipalCredentialId, verifyMcpRequest } from "../mcp/auth.js"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import { mintHeadlessTurnCredentials } from "../headless-runner/resume-grants.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import { jsonResponse, unauthorizedSchema } from "../openapi.js"
import { getOrganizationFeatures } from "../features.js"
import { jsonValidator, tokenRoute } from "../middleware/index.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import { createInternalMcpPrincipalHeader } from "../session.js"
import { getOrganizationContextForUser, listTeamsForMember } from "../orgs.js"
import { listMemberUsableConnectionFacts } from "../routes/org/mcp-connections.js"
import { readWorkbotModel, WORKBOT_DEFAULT_MODEL_ID, workbotModelRecoverySchema, workbotAccessFailureSchema } from "@openwork/types/den/workbot-settings"
import { getMemberInferenceAccess, organizationAllowsManagedModels } from "../inference.js"
import { organizationHasOngoingInferenceSubscription } from "../stripe-billing.js"
import { cloudAgentModelCatalog } from "./model.js"
import { headlessModelAccessSchema } from "@openwork-ee/headless-protocol"
import { CloudAgentGatewayAccessError } from "./gateway-model.js"
import { workbotIncludedDefaultModel, workbotManagedLunaState, workbotUsesManagedDefault } from "./managed-luna.js"
import { recordWorkbotTelemetry, workbotTelemetrySchema, workbotTelemetryServiceAuthorized } from "./telemetry.js"
import { resolvePermissionsForMember } from "../permissions/resolve.js"
import { workbotOrigin } from "./config.js"
import { workbotConnectRequestSchema } from "./connect-return-schema.js"
import { resolvePublicApiBaseUrl } from "../capability-sources/generic-oauth.js"
import { env } from "../env.js"
import { getNativeOAuthProvider } from "../capability-sources/provider-registry.js"
import { activationEventRequestSchema } from "@openwork/types/den/activation"
import { activationResponseSchema } from "../routes/me/activation.js"
import { readActivationState, recordActivationEvent } from "../activation.js"

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
  /** Workbot may use the native apps on its cloud computer. */
  computer: z.boolean().optional(),
  /** Workbot may use the browser on its cloud computer; off on older Dens, which gave the browser with `computer`. */
  browser: z.boolean().optional(),
  browserDemonstrations: z.boolean().optional(),
  /** Compatibility for older clients: equals browser access. Remove when those clients are unsupported. */
  browserLiveView: z.boolean().optional(),
  /** Workbot's computers run through the runner's sandbox gateway instead of its own provider; off on older Dens. */
  sandboxGateway: z.boolean().optional(),
  /** Workbot shows its Calendar tab: Workbot is on. Older Dens omit it. */
  calendar: z.boolean().optional(),
  /** Connected document browsing; off on older Dens. */
  documents: z.boolean().optional(),
  documentEditing: z.boolean().optional(),
  nativeDictation: z.boolean().optional(),
  workspaceAssistant: z.boolean().optional(),
  /** Offers to open mentioned documents and keeps the chat beside them: on with the workspace assistant. */
  guidedNavigation: z.boolean().optional(),
  usageRecovery: z.boolean().optional(),
  /** The Get set up checklist (`GET /v1/workbot/activation`); older Dens omit it: off. */
  activationChecklist: z.boolean().optional(),
  /** The person can start side chats next to their main chat (while Workbot is on). */
  sideChats: z.boolean(),
  /** Always true for older Workbot clients; the command palette is available by default. */
  commandPalette: z.boolean().optional(),
  /**
   * The model Workbot's turns run on: the organization's default model. Null, and
   * omitted by older Dens, means the headless runner's default.
   */
  model: z.string().nullable().optional(),
  /** Require an authenticated runner catalog before new turns; older Dens omit this. Reads remain available. */
  verifyModel: z.boolean().optional(),
  /** Den authorizes the member’s scoped model access for every turn; no deployment catalog precheck. */
  gatewayModels: z.boolean().optional(),
  /**
   * Saved step turns (the wire field keeps its older name): Workbot sends turns to run one step at a time
   * (`execution: "steps"`) and follows them over the runner's WebSocket, so a runner deploy doesn't cut a step off. The
   * server also mints the turns' resume grants. Workbot reads it as off from older Dens.
   */
  stepTurns: z.boolean(),
  /**
   * Per-chat session cells: Workbot creates new chats in their own session cells (`hs_c_…` ids, memory shared
   * through the owner) and asks the runner to split the person's existing chats out. Workbot reads it as off from
   * older Dens.
   */
  sessionCells: z.boolean(),
}).meta({ ref: "WorkbotSession" })

const runTokenSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  /**
   * When the request names the turn (`sessionId` and `messageId`): a resume grant the
   * headless runner can exchange for fresh tokens for this turn, so it continues on its own after a restart.
   */
  resumeGrant: z.string().optional(),
  /** Server-to-server only; never returned in Workbot's browser session or transcript. */
  modelAccess: headlessModelAccessSchema.optional(),
  /**
   * When the request names the session: a capability the headless runner presents to report that conversation's
   * content-free sizes and state to Den's session index. Server-to-server only.
   */
  indexCapability: z.string().optional(),
}).meta({ ref: "WorkbotRunToken" })
const runTokenRequestSchema = z.object({
  ttlMs: z.number().int().min(60_000).max(DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS).optional(),
  readOnly: z.boolean().optional(),
  /** The headless runner session and message the turn is sent as; both are needed for a resume grant. */
  sessionId: z.string().min(1).max(128).optional(),
  messageId: z.string().min(1).max(128).optional(),
  /** A retry may name its original model. Den rechecks this member's current access to that exact alias. */
  model: z.string().min(1).max(512).optional(),
  /** Recover an existing managed turn across rollout rollback; Den verifies its persisted owner and model. */
  modelAccessRequired: z.boolean().optional(),
})
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
    app: z.enum(["gmail", "googleCalendar", "slack", "microsoft"]),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
    nativeProviderKey: z.string().nullable().optional(),
    connectMode: z.enum(["inline", "external", "admin"]).optional(),
  })),
})

/** Which everyday app a connection is, for Workbot's welcome: Gmail (or Google Workspace), Slack, or Microsoft 365. */
function everydayApp(fact: { name: string; url: string; nativeProviderKey: string | null }): "gmail" | "googleCalendar" | "slack" | "microsoft" | null {
  const key = fact.nativeProviderKey?.toLowerCase() ?? ""
  const text = `${fact.name} ${fact.url}`.toLowerCase()
  if (/google[ -]calendar|\bgcal\b/.test(text)) return "googleCalendar"
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
  { method: "GET", path: /^\/v1\/org\/workbot-settings$/, write: false },
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
  app.get("/v1/workbot/model-recovery", describeWorkbotRoute({
    tags: ["Workbot"], operationId: "getWorkbotModelRecovery", "x-mcp": false,
    summary: "Get my Workbot model recovery options",
    description: "Read-only navigation hints and the authenticated member's own free allowance reset. Requires a live Workbot member token with read scope. Purchase hints require current permissions and configured billing and Models provisioning. Never returns credentials or starts checkout. Destination pages recheck permissions and select the token's organization.",
    responses: {
      200: jsonResponse("The member's recovery options.", workbotModelRecoverySchema),
      401: jsonResponse("The token or membership is invalid.", unauthorizedSchema),
      403: jsonResponse("Read scope is required.", z.object({ error: z.literal("insufficient_scope") })),
    },
  }), tokenRoute, async (c) => {
    c.header("Cache-Control", "no-store")
    const resolved = await resolve(c.req.raw.headers)
    if (resolved instanceof Response) return resolved
    const auditBlocked = await attributeWorkbot(c, resolved)
    if (auditBlocked) return auditBlocked
    if (!resolved.scopes.has(DEN_MCP_READ_SCOPE)) return c.json({ error: "insufficient_scope" }, 403)
    const { organization, memberId, user } = resolved
    const [permissions, access, allowed, subscribed] = await Promise.all([
      resolvePermissionsForMember({ organizationId: organization.id, memberId: normalizeDenTypeId("member", memberId) }),
      getMemberInferenceAccess({ organizationId: organization.id, memberId: normalizeDenTypeId("member", memberId), userId: normalizeDenTypeId("user", user.id) }),
      organizationAllowsManagedModels(organization.id),
      organizationHasOngoingInferenceSubscription(organization.id),
    ])
    const chosen = readWorkbotModel(organization.metadata)
    const managedLuna = workbotUsesManagedDefault(chosen)
    const managed = managedLuna ? await workbotManagedLunaState({ organizationId: organization.id, userId: user.id }).catch(() => null) : null
    const purchaseEligible = allowed && !subscribed && !managed?.paid && Boolean(env.stripe.secretKey && env.stripe.inferencePriceId && env.openRouterManagementApiKey) && permissions.has("billing.manage") && permissions.has("inference.view")
    const afterUpgrade = managedLuna && managed?.allowed === true && ["free", "exhausted"].includes(managed.free.kind) && purchaseEligible
    const paidContinuation = managed?.paidReady ? "authorized" : afterUpgrade ? "after_upgrade" : "unavailable"
    return c.json({
      canUpgrade: access.kind === "exhausted" && paidContinuation === "after_upgrade",
      purchaseEligible,
      managedLuna,
      hasModelsSubscription: subscribed || managed?.paid === true,
      paidContinuation,
      upgradeBlockedReason: paidContinuation === "unavailable" ? "paid_workbot_route_unavailable" : null,
      canManageModels: permissions.has("inference.manage") && permissions.has("inference.view"),
      canManageBilling: permissions.has("billing.view") && permissions.has("billing_portal.use"),
      freeExhausted: access.kind === "exhausted",
      freeResetsAt: access.kind === "exhausted" ? access.resetsAt : null,
    })
  })
  app.post(
    "/v1/workbot/telemetry",
    describeWorkbotRoute({
      tags: ["Workbot"], operationId: "recordWorkbotTelemetry", "x-mcp": false,
      summary: "Record content-free Workbot service facts",
      description: "Server-to-server only: requires the runner service credential and a live member MCP token. Org and member are resolved from the token. No text or caller-supplied identity is accepted. Telemetry storage failure never fails a user flow.",
      responses: { 204: { description: "Accepted, including best-effort storage failures." }, 401: jsonResponse("Service or member credentials are invalid.", unauthorizedSchema) },
    }),
    tokenRoute,
    bodyLimit({ maxSize: 4096 }),
    async (c, next) => {
      if (!workbotTelemetryServiceAuthorized(c.req.header("x-openwork-workbot-service"))) return c.json({ error: "unauthorized" }, 401)
      await next()
    },
    jsonValidator(workbotTelemetrySchema),
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
      const event = c.req.valid("json")
      // Completion records even if the originating session has already ended.
      await recordWorkbotTelemetry({ organizationId: resolved.organization.id, memberId: resolved.memberId }, event, async () => {
        const organizationContext = await getOrganizationContextForUser({ userId: normalizeDenTypeId("user", resolved.principal.userId), organizationId: resolved.organization.id })
        if (!organizationContext) return null
        const memberTeams = await listTeamsForMember({ organizationId: resolved.organization.id, memberId: normalizeDenTypeId("member", resolved.memberId) })
        const facts = await listMemberUsableConnectionFacts({ context: { organizationContext, memberTeams, session: null } })
        return facts.filter((fact) => !fact.setupRequired && fact.connectedForMe && !fact.needsReconnect).length
      })
      return c.body(null, 204)
    },
  )

  app.get(
    "/v1/workbot/session",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "getWorkbotSession",
      "x-mcp": false,
      summary: "Who is signed in to Workbot",
      description:
        "For the Workbot app only. With the access token a person got by signing in to Workbot through Den, returns who they are, the workspace they chose, and their available Workbot tools.",
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
      const features = await getOrganizationFeatures(organization.id, { userId: user.id })
      const chosen = readWorkbotModel(organization.metadata)
      const managed = workbotUsesManagedDefault(chosen) ? await workbotIncludedDefaultModel({ organizationId: organization.id, userId: user.id }, chosen) : null
      // Keep history readable during access failures. Starting a turn reauthorizes the exact model in Den.
      const model = managed
        ?? chosen ?? (await cloudAgentModelCatalog({ organizationId: organization.id, userId: user.id }).catch(() => null))?.defaultModel ?? WORKBOT_DEFAULT_MODEL_ID
      return c.json({
        user,
        organization: { id: organization.id, name: organization.name, brandAppName: readBrandAppName(organization.metadata) },
        memberId,
        enabled: true,
        // Workbot's browser and its other desktop apps share one cloud computer but are rolled out separately.
        computer: features.computerUse && features.remoteComputers,
        browser: features.browserUse && features.remoteComputers,
        browserDemonstrations: features.browserDemonstrations && features.browserUse && features.remoteComputers,
        // Compatibility for older Workbot clients: the page stream now follows browser access.
        browserLiveView: features.browserUse && features.remoteComputers,
        sandboxGateway: features.sandboxGateway,
        canSchedule,
        calendar: true,
        documents: features.workbotDocuments,
        documentEditing: features.workbotDocuments && features.workbotDocumentEditing,
        nativeDictation: features.nativeDictation,
        workspaceAssistant: features.workbotWorkspaceAssistant,
        guidedNavigation: features.workbotWorkspaceAssistant,
        // The limit card and model recovery links: included models need them as much as upgrades do.
        usageRecovery: true,
        activationChecklist: true,
        sideChats: true,
        commandPalette: true,
        model,
        gatewayModels: true,
        stepTurns: true,
        sessionCells: true,
      })
    },
  )

  /** The member's Get set up checklist, for Workbot's header. Same facts and rules as `GET /v1/me/activation`. */
  const activationFor = async (c: Context, write: boolean) => {
    c.header("Cache-Control", "no-store")
    const resolved = await resolve(c.req.raw.headers)
    if (resolved instanceof Response) return resolved
    const auditBlocked = await attributeWorkbot(c, resolved)
    if (auditBlocked) return auditBlocked
    if (!resolved.scopes.has(DEN_MCP_READ_SCOPE) || (write && !resolved.scopes.has(DEN_MCP_WRITE_SCOPE))) return c.json({ error: "insufficient_scope" }, 403)
    const organizationContext = await getOrganizationContextForUser({ userId: normalizeDenTypeId("user", resolved.principal.userId), organizationId: resolved.organization.id })
    if (!organizationContext) return c.json({ error: "membership_revoked", message: "This account is no longer a member of the workspace." }, 401)
    const memberTeams = await listTeamsForMember({ organizationId: resolved.organization.id, memberId: normalizeDenTypeId("member", resolved.memberId) })
    return { organizationContext, memberTeams, resolved }
  }
  const activationResponses = {
    401: jsonResponse("The token or membership is invalid.", unauthorizedSchema),
    403: jsonResponse("The sign-in grant does not allow this.", z.object({ error: z.literal("insufficient_scope") })),
  }
  app.get(
    "/v1/workbot/activation",
    describeWorkbotRoute({
      tags: ["Workbot"], operationId: "getWorkbotActivation", "x-mcp": false,
      summary: "The member's Get set up checklist, for Workbot",
      description: "For the Workbot app only. With a live Workbot member token (read scope), returns the same six activation steps as GET /v1/me/activation for the token's organization and member.",
      responses: { 200: jsonResponse("The member's checklist.", activationResponseSchema), ...activationResponses },
    }),
    tokenRoute,
    async (c) => {
      const context = await activationFor(c, false)
      if (context instanceof Response) return context
      return c.json(await readActivationState(context))
    },
  )
  app.post(
    "/v1/workbot/activation/events",
    describeWorkbotRoute({
      tags: ["Workbot"], operationId: "recordWorkbotActivationEvent", "x-mcp": false,
      summary: "Report a Get set up step Workbot observed",
      description: "For the Workbot app only. With a live Workbot member token (read and write scopes), records the member's first Workbot answer or that they hid the checklist, then returns the updated checklist. Repeats are ignored.",
      responses: { 200: jsonResponse("The updated checklist.", activationResponseSchema), 400: jsonResponse("The event is not one Workbot may report.", signedOutSchema), ...activationResponses },
    }),
    tokenRoute,
    bodyLimit({ maxSize: 1024 }),
    jsonValidator(activationEventRequestSchema),
    async (c) => {
      const context = await activationFor(c, true)
      if (context instanceof Response) return context
      await recordActivationEvent({ organizationId: context.resolved.organization.id, memberId: context.resolved.memberId }, c.req.valid("json"), "workbot")
      return c.json(await readActivationState(context))
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
      const organizationContext = await getOrganizationContextForUser({ userId: normalizeDenTypeId("user", resolved.principal.userId), organizationId: resolved.organization.id })
      if (!organizationContext) return c.json({ connections: [] })
      const memberTeams = await listTeamsForMember({ organizationId: resolved.organization.id, memberId: normalizeDenTypeId("member", resolved.memberId) })
      const facts = await listMemberUsableConnectionFacts({ context: { organizationContext, memberTeams, session: null } })
      const inline = Boolean(workbotOrigin())
      const connections = facts.flatMap((fact) => {
        const app = everydayApp(fact)
        if (!app) return []
        // Set up by an admin but not finished there: not something the member can do anything about yet.
        if (fact.setupRequired === true && !inline) return []
        const ready = fact.connectedForMe && !fact.needsReconnect
        const connectMode: "admin" | "inline" | "external" = fact.setupRequired === true ? "admin" : inline ? "inline" : "external"
        return [{ id: fact.id, name: fact.name, app, ready, connectUrl: ready ? null : openworkYourConnectionsUrl(fact.id), nativeProviderKey: fact.nativeProviderKey, connectMode }]
      })
      return c.json({ connections })
    },
  )

  app.post(
    "/v1/workbot/connections/:connectionId/connect/start",
    describeWorkbotRoute({
      tags: ["Workbot"], operationId: "startWorkbotConnection", "x-mcp": false,
      summary: "Connect the member's assigned account from Workbot",
      description: "Requires a live Workbot OAuth grant with write scope and active membership. Re-enters the existing connection start as that member in the token's organization; the same connection grants and permissions apply. Only a path on the configured Workbot origin can be signed into OAuth state.",
      responses: {
        200: jsonResponse("Provider consent URL and its callback origin.", z.object({ authorizeUrl: z.string().nullable(), status: z.string().optional(), callbackOrigin: z.string() })),
        400: jsonResponse("Invalid connection or return path.", signedOutSchema),
        401: jsonResponse("The token or membership is no longer valid.", unauthorizedSchema),
        403: jsonResponse("The grant or connection permission is missing.", signedOutSchema),
        404: jsonResponse("Connecting from Workbot is not configured, or the connection is unavailable.", signedOutSchema),
      },
    }),
    tokenRoute,
    bodyLimit({ maxSize: 4096 }),
    jsonValidator(workbotConnectRequestSchema),
    async (c) => {
      c.header("cache-control", "no-store")
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
      if (!workbotOrigin()) return c.json({ error: "feature_disabled", message: "Connect from your workspace connections page instead." }, 404)
      if (!resolved.scopes.has(DEN_MCP_WRITE_SCOPE)) return c.json({ error: "insufficient_scope", message: "Sign in again with permission to connect accounts." }, 403)
      const input = c.req.valid("json")
      const connectionId = c.req.param("connectionId")
      if (!getNativeOAuthProvider(connectionId)) {
        try { normalizeDenTypeId("externalMcpConnection", connectionId) } catch { return c.json({ error: "invalid_request" }, 400) }
      }
      const query = new URLSearchParams({ workbotReturnPath: input.returnPath, workbotRequestId: input.requestId })
      const headers = new Headers({ accept: "application/json", "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId: resolved.principal.userId, organizationId: resolved.principal.organizationId, credentialId: resolved.credentialId }) })
      const base = resolvePublicApiBaseUrl(c.req.raw, env.apiPublicUrl)
      const response = await app.fetch(new Request(new URL(`/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start?${query}`, c.req.url), { headers }))
      const payload: unknown = await response.json().catch(() => null)
      const started = z.object({ authorizeUrl: z.string().nullable(), status: z.string().optional() }).safeParse(payload)
      if (response.ok && started.success) return c.json({ ...started.data, callbackOrigin: new URL(base).origin })
      return new Response(JSON.stringify(payload), { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
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
        "For the Workbot app only. Forwards an allowlisted Den route, as the member behind the Workbot token: GET /v1/automations, GET /v1/automation-runs, GET /v1/automations/{id}/runs, GET /v1/automation-runs/{id}, GET /v1/capabilities/{google-workspace|microsoft-365}/calendar-events, GET /v1/llm-providers (names and model IDs only), GET /v1/org/workbot-settings (subject to the destination's feature and permission guards), POST /v1/automations/{id}/{activate|deactivate|run}, POST /v1/cloud-automations and a PATCH /v1/automations/{id} limited to name, schedule, instructions and model. The destination routes enforce their own permissions and remaining feature guards.",
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

  app.on(
    ["GET", "POST"],
    "/v1/workbot/documents/*",
    bodyLimit({ maxSize: 2 * 1024 * 1024 }),
    describeWorkbotRoute({
      tags: ["Workbot"], operationId: "workbotDocumentsProxy", "x-mcp": false,
      summary: "Browse, open and explicitly save connected documents",
      description: "Allowlisted Drive metadata and inline-editor routes only. Rechecks membership, scopes and both feature flags; signed internal re-entry retains connector authorization. File bytes and document contents never enter chat.",
      responses: { 200: jsonResponse("The document route's response.", z.unknown()), 403: jsonResponse("Documents is disabled or this scope is missing.", signedOutSchema) },
    }),
    tokenRoute,
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
      const inner = c.req.path.slice("/v1/workbot/documents".length)
      const editor = /^\/v1\/documents\/(?:google-drive|microsoft-365)\/files\/[A-Za-z0-9_-]{1,512}\/(editor|content|metadata)$/.exec(inner)
      const office = /^\/v1\/documents\/google-drive\/files\/[A-Za-z0-9_-]{1,512}\/office(?:\/[0-9a-f-]{36}(?:\/(save|close))?)?$/.exec(inner)
      const read = c.req.method === "GET"
      if (!(read && (inner === "/v1/capabilities/google-workspace/drive-files" || inner === "/v1/documents/microsoft-365/files")) && !(editor && (read || editor[1] === "editor")) && !(office && (read ? !office[1] && /\/[0-9a-f-]{36}$/.test(inner) : inner.endsWith("/office") || !!office[1]))) return c.json({ error: "not_found" }, 404)
      const features = await getOrganizationFeatures(resolved.organization.id, { userId: resolved.user.id })
      if (editor?.[1] === "metadata" && !features.workbotWorkspaceAssistant) return c.json({ error: "feature_disabled", message: "Opening document links is off for this workspace." }, 403)
      if (!features.workbotDocuments) return c.json({ error: "workbot_documents_not_enabled", message: "Documents is off for this workspace." }, 403)
      if (!read && !inner.endsWith("/close") && !features.workbotDocumentEditing) return c.json({ error: "feature_disabled", message: "Document editing is off for this workspace." }, 403)
      if (!resolved.scopes.has(read ? DEN_MCP_READ_SCOPE : DEN_MCP_WRITE_SCOPE)) return c.json({ error: "insufficient_scope" }, 403)
      const url = new URL(c.req.url)
      const headers = new Headers({ accept: "application/json", "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId: resolved.principal.userId, organizationId: resolved.principal.organizationId, credentialId: resolved.credentialId }) })
      let body: string | undefined
      if (!read) {
        // The destination's bodyLimit is also authoritative, including for a forged Content-Length.
        if (Number(c.req.header("content-length")) > 2 * 1024 * 1024) return c.json({ error: "file_too_large" }, 413)
        body = await c.req.text()
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) return c.json({ error: "file_too_large" }, 413)
        headers.set("content-type", "application/json")
      }
      const response = await app.fetch(new Request(new URL(`${inner}${url.search}`, "http://den-api.local"), { method: c.req.method, headers, body }))
      // Den reports a Google refusal (for example a Google API turned off for the
      // connector) as 502. The tunnel in front of Den replaces 502 bodies with its
      // own page, so Workbot lost the reason. 424 carries the same body intact.
      const status = response.status === 502 ? 424 : response.status
      return new Response(response.body, { status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(editor?.[1] === "content" ? { "content-security-policy": "default-src 'none'; sandbox" } : {}) } })
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
        "For the Workbot app only. Mints the member-scoped MCP token a Workbot turn uses to reach the person's connected apps on the headless runner, for at most an hour. With `sessionId` and `messageId`, and where turns keep going on their own for the workspace, also returns a resume grant for that turn. With `sessionId` and where the session index is on for the workspace, also returns an index capability for that session. With scoped model access, also returns the member’s Gateway or managed Models route and bearer credential for the exact selected model, rechecking access for every turn. This response is server-to-server only and must not be forwarded to a browser or logged. Refused when Workbot is off for the workspace.",
      responses: {
        200: jsonResponse("The token.", runTokenSchema),
        401: jsonResponse("The token is missing, expired or revoked, or the membership ended.", unauthorizedSchema),
        403: jsonResponse("Workbot or model access cannot start a turn.", z.union([signedOutSchema, workbotAccessFailureSchema])),
        429: jsonResponse("Too many tokens requested.", z.object({ error: z.literal("rate_limited"), retryAfter: z.number() })),
      },
    }),
    tokenRoute,
    jsonValidator(runTokenRequestSchema),
    async (c) => {
      const resolved = await resolve(c.req.raw.headers)
      if (resolved instanceof Response) return resolved
      const auditBlocked = await attributeWorkbot(c, resolved)
      if (auditBlocked) return auditBlocked
      const { principal, organization } = resolved
      const readOnly = c.req.valid("json").readOnly === true
      const requiredScopes = readOnly ? [DEN_MCP_READ_SCOPE] : [DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE]
      if (requiredScopes.some((scope) => !resolved.scopes.has(scope))) {
        return c.json({ error: "workbot_turn_access_denied", reason: "oauth_scope_missing" }, 403)
      }
      const retryAfter = await checkRateLimit(`workbot-run-token:${principal.organizationId}:${principal.userId}`, RUN_TOKENS_PER_WINDOW, RUN_TOKEN_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
      const { ttlMs = DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS, sessionId, messageId, model: requestedModel } = c.req.valid("json")
      let model = requestedModel
      try {
        const chosen = readWorkbotModel(organization.metadata)
        if (!model && workbotUsesManagedDefault(chosen)) {
          model = await workbotIncludedDefaultModel(principal, chosen) ?? undefined
        }
        // Credential minting still reauthorizes the exact model for this member on every turn.
        const { token, resumeGrant, modelAccess, indexCapability } = await mintHeadlessTurnCredentials({
          ...principal, ttlMs, readOnly, sessionId, messageId, model, indexKind: "workbot", memberId: resolved.memberId,
        })
        return c.json({
          token,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          ...(resumeGrant ? { resumeGrant } : {}),
          ...(modelAccess ? { modelAccess } : {}),
          ...(indexCapability ? { indexCapability } : {}),
        })
      } catch (error) {
        return c.json({ error: "workbot_turn_access_denied", reason: error instanceof CloudAgentGatewayAccessError ? error.reason : "model_access_unavailable" }, 403)
      }
    },
  )
}
