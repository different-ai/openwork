import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
  AUTOMATION_SCHEDULE_KINDS_HEADER,
  automationDesktopRunnerAssignmentSchema,
  automationDesktopRunnerPresenceSchema,
  automationDesktopRunnerResultSchema,
  automationDetailSchema,
  automationExecutionTargetListSchema,
  automationListSchema,
  AUTOMATION_RUN_RANGE_MAX_DAYS,
  automationRunRangeQuerySchema,
  automationRunRangeSchema,
  automationRunReceiptSchema,
  automationRunSchema,
  automationRunnerEventRequestSchema,
  automationRunnerHeartbeatRequestSchema,
  automationRunnerHeartbeatResponseSchema,
  automationRoleAllows,
  automationSharingSchema,
  createAutomationSchema,
  createCloudAutomationSchema,
  readableAutomationScheduleKinds,
  runAutomationNowSchema,
  shareAutomationWithTeamSchema,
  updateAutomationSchema,
  type AutomationAccessRole,
} from "@openwork/types/automations"
import type { AutomationListItem } from "@openwork/automations"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  queryValidator,
  validationIssuesMessage,
  type OrganizationContextVariables,
} from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { automationService, type AutomationService } from "../../automations/service.js"
import {
  AutomationSharingError,
  readAutomationSharing,
  resolveAutomationAccess,
  resolveAutomationRunAccess,
  shareAutomationWithTeam,
  stopSharingAutomationWithTeam,
  withAutomationAccess,
  type AutomationCallerAccess,
} from "../../automations/sharing.js"
import { requireFeature } from "../../features.js"
import { markFeaturesUsed } from "../../feature-usage.js"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { registerSessionRunnerRoutes } from "../session-runners/index.js"
import { createRunnerProtocol, runnerRoute, runnerErrorSchema, runnerConflictResponse } from "../session-runners/protocol.js"
import { OpenWorkWebAccessRequiredError } from "../../openwork-web-runtime-access.js"
import type { RemoteSessionCommandStore } from "../../remote-sessions/commands.js"
import type { RemoteSessionRequestStore } from "../../remote-sessions/requests.js"

const idParamsSchema = z.object({ id: z.string().min(1).max(160) })
const teamShareParamsSchema = z.object({ id: z.string().min(1).max(160), teamId: z.string().min(1).max(160) })
const automationAccessDeniedSchema = z.object({
  error: z.enum(["automation_manage_required", "automation_owner_only", "automation_share_team_not_allowed"]),
  message: z.string(),
}).meta({ ref: "AutomationAccessDeniedError" })
const automationRunParamsSchema = z.object({ id: z.string().min(1).max(160) })
const paginationSchema = z.object({
  cursor: z.string().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
const runListSchema = z.object({ items: z.array(automationRunSchema), nextCursor: z.string().nullable() }).meta({ ref: "AutomationRunList" })
const runResponseSchema = z.object({ run: automationRunSchema }).meta({ ref: "AutomationRunResponse" })
const runnerClaimResponseSchema = z.object({ assignment: automationDesktopRunnerAssignmentSchema.nullable() })
const openWorkWebAccessRequiredSchema = z.object({
  error: z.literal("openwork_web_access_required"),
  message: z.string(),
}).meta({ ref: "AutomationOpenWorkWebAccessRequiredError" })
type McpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": true }
const describeMcpRoute = (options: McpDescribeRouteOptions) => describeRoute(options)
// Runner-credential routes must never surface as MCP tools; an MCP caller with
// write scope could otherwise mint a desktop-runner bearer credential.
type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

type RouteVariables = Partial<OrganizationContextVariables> & Partial<Pick<AuthContextVariables, "session">>

type ScopeContext = {
  get(name: "organizationContext"): OrganizationContextVariables["organizationContext"]
  req: { header(name: string): string | undefined }
}

function scope(c: ScopeContext) {
  const context = c.get("organizationContext")
  const modelAttentionCapable = c.req.header(AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER)
    === AUTOMATION_MODEL_ATTENTION_CAPABILITY
  return {
    organizationId: context.organization.id,
    ownerMemberId: context.currentMember.id,
    modelAttentionCapable,
    // Only first-party desktops send the model-attention header, so only they are narrowed.
    readableScheduleKinds: readableAutomationScheduleKinds({
      scheduleKindsHeader: c.req.header(AUTOMATION_SCHEDULE_KINDS_HEADER),
      firstPartyDesktop: modelAttentionCapable,
    }),
  }
}

const MANAGE_REQUIRED = {
  status: 403 as const,
  body: {
    error: "automation_manage_required" as const,
    message: "Your team can view this Automation. Its owner can give your team manage access to pause, resume or run it.",
  },
}
const OWNER_ONLY = {
  status: 403 as const,
  body: {
    error: "automation_owner_only" as const,
    message: "Only its owner can edit, archive or share this Automation, or choose where it runs.",
  },
}

function sharingOn(c: ScopeContext) {
  return c.get("organizationContext").features.automationTeamSharing
}

function caller(c: ScopeContext) {
  const context = c.get("organizationContext")
  return { organizationId: context.organization.id, memberId: context.currentMember.id }
}

type AccessDecision =
  | { ok: true; scope: ReturnType<typeof scope>; role: AutomationAccessRole }
  | { ok: false; denied: typeof MANAGE_REQUIRED | typeof OWNER_ONLY }

/**
 * The scope a request acts in. The service is owner-scoped, and a shared
 * Automation still belongs to (and runs as) its owner, so a teammate's request
 * is carried out in the owner's scope once sharing says they may do it. With
 * sharing off, or for an Automation the caller cannot reach, this is the
 * caller's own scope and the service answers "not found" as it always has.
 */
function decideAccess(c: ScopeContext, access: AutomationCallerAccess | null, need: AutomationAccessRole): AccessDecision {
  const own = scope(c)
  if (!access || access.role === "owner") return { ok: true, scope: own, role: "owner" }
  if (!automationRoleAllows(access.role, need)) return { ok: false, denied: need === "owner" ? OWNER_ONLY : MANAGE_REQUIRED }
  const context = c.get("organizationContext")
  markFeaturesUsed({ organizationId: context.organization.id, memberId: context.currentMember.id, keys: ["automationTeamSharing"] })
  return { ok: true, scope: { ...own, ownerMemberId: access.ownerMemberId }, role: access.role }
}

async function automationAccess(c: ScopeContext, automationId: string, need: AutomationAccessRole): Promise<AccessDecision> {
  return decideAccess(c, sharingOn(c) ? await resolveAutomationAccess({ ...caller(c), automationId }) : null, need)
}

async function runAccess(c: ScopeContext, runId: string, need: AutomationAccessRole): Promise<AccessDecision> {
  return decideAccess(c, sharingOn(c) ? await resolveAutomationRunAccess({ ...caller(c), runId }) : null, need)
}

/** Adds the caller's `access` (owner, manage or view, and the teams) when sharing is on. */
async function described<T extends AutomationListItem>(c: ScopeContext, item: T) {
  return sharingOn(c) ? (await withAutomationAccess(caller(c), [item]))[0] ?? item : item
}

/** MCP tool calls reach these routes with the internal agent session. */
function placementOptions(c: { get(name: "session"): { id: string } | null | undefined }) {
  return { agentCaller: c.get("session")?.id === "mcp_internal" }
}

/**
 * The run body is optional: released clients send `{}` and agents may send
 * nothing, so it is read here instead of through a required-body validator.
 */
async function runNowBody(c: { req: { text(): Promise<string> } }) {
  const text = await c.req.text()
  if (!text.trim()) return runAutomationNowSchema.safeParse({})
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return runAutomationNowSchema.safeParse(body)
}

function failure(error: unknown): { status: 400 | 403 | 404 | 409; body: { error: string; message?: string } } | null {
  if (error instanceof OpenWorkWebAccessRequiredError) {
    return { status: 403, body: { error: error.code, message: error.message } }
  }
  if (error instanceof AutomationSharingError) {
    if (error.code === "automation_not_found") return { status: 404, body: { error: error.code } }
    if (error.code === "automation_manage_required") return MANAGE_REQUIRED
    if (error.code === "automation_share_team_not_allowed") {
      return { status: 403, body: { error: error.code, message: "You can share an Automation with teams you are on." } }
    }
    if (error.code === "automation_share_limit_reached") {
      return { status: 409, body: { error: error.code, message: "This Automation is already shared with as many teams as it can be. Stop sharing with one first." } }
    }
    if (error.code === "automation_already_owned") {
      return { status: 409, body: { error: error.code, message: "This Automation is already yours." } }
    }
    return { status: 409, body: { error: error.code, message: "A run is in progress. Take this Automation over once it finishes, or cancel the run first." } }
  }
  if (!(error instanceof Error)) return null
  if (error.message === "automation_runner_identity_conflict") {
    return { status: 409, body: { error: error.message, message: "This desktop runner identity is already registered to a different organization member." } }
  }
  if (error.message === "automation_not_found") return { status: 404, body: { error: "automation_not_found" } }
  if (error.message === "automation_action_target_mismatch") {
    return { status: 400, body: { error: "automation_action_target_mismatch", message: "This Automation runs only in OpenWork Cloud." } }
  }
  if (error.message === "automation_agent_desktop_placement") {
    return { status: 400, body: { error: error.message, message: "Agents can run Automations only in OpenWork Cloud. To use a desktop, change where it runs in OpenWork." } }
  }
  if (error.message === "automation_saved_script_input_invalid") {
    return { status: 400, body: { error: "automation_saved_script_input_invalid", message: "The existing Automation input does not match the selected Workflow version. Correct the input before creating the revision." } }
  }
  if (["automation_saved_script_version_not_found", "automation_saved_script_version_invalid"].includes(error.message)) {
    return { status: 400, body: { error: error.message, message: "The selected Workflow version is unavailable." } }
  }
  if (error.message === "automation_saved_script_forbidden") {
    return { status: 403, body: { error: error.message, message: "The Automation owner does not have access to this Workflow." } }
  }
  if (error.message === "automation_owner_inactive") {
    return { status: 409, body: { error: error.message, message: "The Automation owner is no longer an active organization member." } }
  }
  if (error.message === "automation_desktop_disabled") {
    return { status: 403, body: { error: error.message, message: "Desktop Automations are turned off for this organization. An admin can turn them on in Settings." } }
  }
  if (error.message === "automation_cloud_disabled") {
    return { status: 403, body: { error: error.message, message: "Cloud Automations are not available for this organization. An admin can turn them on in Settings once OpenWork's headless runner is set up." } }
  }
  if (error.message === "automation_calendar_trigger_cloud_only") {
    return { status: 400, body: { error: error.message, message: "Automations that run around meetings run in OpenWork Cloud. Create it as a Cloud Automation, or choose a clock schedule to run it on a desktop." } }
  }
  if (error.message === "automation_cloud_worker_required") {
    return { status: 409, body: { error: error.message, message: "Set up OpenWork Cloud before creating a Cloud Automation." } }
  }
  if (["owner_membership_lost", "model_access_lost", "provider_unavailable"].includes(error.name)) {
    return { status: 409, body: { error: error.name, message: error.message } }
  }
  return null
}

const routeDescription = [
  "Den schedules Automations and keeps durable run history.",
  "A Desktop Automation runs on any of the owner's connected desktops (one pinned to a workspace, on a desktop that has it); a Cloud Automation runs in OpenWork Cloud.",
  "If no desktop runner is connected when a desktop occurrence is due, that occurrence is recorded as missed.",
  "Creation makes an Automation active immediately and uses the owner's current OpenWork Connect integrations.",
  "Deactivation stops future runs but does not cancel a run already in progress.",
].join(" ")

export function registerAutomationRoutes<T extends { Variables: RouteVariables }>(
  app: Hono<T>,
  options: {
    service?: AutomationService
    commandStore?: RemoteSessionCommandStore
    requestStore?: RemoteSessionRequestStore
    enabled?: boolean
    /** The app registers the independent runner owner explicitly. */
    sessionRunners?: boolean
  } = {},
) {
  const service = options.service ?? automationService
  if (options.sessionRunners !== false) registerSessionRunnerRoutes(app, {
    service: options.service,
    automationService: options.enabled === false ? undefined : service,
    commandStore: options.commandStore,
    requestStore: options.requestStore,
  })
  if (options.enabled === false) return

  app.get(
    "/v1/automation-runners/presence",
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "getAutomationDesktopRunnerPresence", "x-mcp": false,
      summary: "Report whether a desktop runner is connected",
      description: "Desktop Automations only run while one of the owner's desktops is connected. "
        + "Management surfaces read this to warn before an occurrence is due rather than after it was missed.",
      responses: {
        200: jsonResponse("Desktop runner presence.", automationDesktopRunnerPresenceSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Organization not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => c.json(await service.desktopRunnerPresence(scope(c))),
  )

  app.get(
    "/v1/automation-runners",
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "listAutomationRunners", "x-mcp": false,
      summary: "List where this member's Automations can run",
      description: "Returns the member's registered desktops, most recently seen first, and whether OpenWork Cloud can run their "
        + "agent Automations right now. Any connected desktop may run a Desktop Automation; one pinned to a workspace runs on a "
        + "desktop that has that workspace. Management surfaces read this to offer a choice of where an Automation runs.",
      responses: {
        200: jsonResponse("Execution targets.", automationExecutionTargetListSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Organization not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => c.json(await service.executionTargets(scope(c))),
  )

  const { authenticateRunner, attributeRunner } = createRunnerProtocol(service)

  app.post(
    "/v1/automation-runs/:id/claim",
    runnerRoute({
      summary: "Claim an Automation run",
      responses: { 200: jsonResponse("The claimed run assignment, or null when the run is no longer claimable.", runnerClaimResponseSchema) },
    }),
    paramValidator(automationRunParamsSchema),
    async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    const audited = await attributeRunner(c, identity)
    if (!audited.ok) return audited.response
    const assignment = await service.claimDesktopRunner(identity, c.req.valid("param").id)
    return c.json(runnerClaimResponseSchema.parse({ assignment }))
    },
  )

  app.post(
    "/v1/automation-runs/:id/heartbeat",
    runnerRoute({
      summary: "Extend an Automation run lease",
      responses: {
        200: jsonResponse("The lease was extended.", z.object({ ok: z.literal(true) })),
        409: runnerConflictResponse,
      },
    }),
    paramValidator(automationRunParamsSchema),
    jsonValidator(automationRunnerHeartbeatRequestSchema),
    async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    const audited = await attributeRunner(c, identity)
    if (!audited.ok) return audited.response
    const heartbeat = await service.heartbeatDesktopRunner(identity, c.req.valid("param").id, c.req.valid("json").attempt)
    return heartbeat
      ? c.json(automationRunnerHeartbeatResponseSchema.parse(heartbeat))
      : c.json({ error: "runner_lease_lost" }, 409)
    },
  )

  app.post(
    "/v1/automation-runs/:id/events",
    runnerRoute({
      summary: "Append an Automation run event",
      responses: {
        200: jsonResponse("The recorded event.", z.object({ event: z.object({}).passthrough() })),
        409: runnerConflictResponse,
        500: jsonResponse("The event could not be recorded.", runnerErrorSchema),
      },
    }),
    paramValidator(automationRunParamsSchema), jsonValidator(automationRunnerEventRequestSchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      try {
        return c.json({ event: await service.appendDesktopRunnerEvent(
          identity,
          c.req.valid("param").id,
          c.req.valid("json"),
        ) })
      } catch (error) {
        const reason = error instanceof Error ? error.message : ""
        if (reason === "automation_run_lease_lost") return c.json({ error: "runner_lease_lost" }, 409)
        if (reason === "automation_runner_event_sequence_gap") {
          return c.json({ error: "automation_runner_event_sequence_gap" }, 409)
        }
        // Anything else is an internal failure; never echo raw error text to runners.
        return c.json({ error: "runner_event_rejected" }, 500)
      }
    },
  )

  app.post(
    "/v1/automation-runs/:id/complete",
    runnerRoute({
      summary: "Complete an Automation run",
      responses: {
        200: jsonResponse("The completed run.", runResponseSchema),
        409: runnerConflictResponse,
        500: jsonResponse("The completion could not be recorded; the runner should retry.", runnerErrorSchema),
      },
    }),
    paramValidator(automationRunParamsSchema), jsonValidator(automationDesktopRunnerResultSchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      try {
        return c.json({ run: await service.completeDesktopRunner(
          identity,
          c.req.valid("param").id,
          c.req.valid("json"),
        ) })
      } catch (error) {
        const reason = error instanceof Error ? error.message : ""
        if (reason === "automation_run_terminal_result_conflict") {
          return c.json({ error: "terminal_result_conflict" }, 409)
        }
        if (reason === "automation_run_complete_lease_lost" || reason === "automation_run_lease_lost") {
          return c.json({ error: "runner_lease_lost" }, 409)
        }
        // A transient fault must not read as a lost lease, or runners abandon
        // result reporting; 500 lets the desktop retry completion.
        return c.json({ error: "runner_completion_failed" }, 500)
      }
    },
  )

  app.get(
    "/v1/automations",
    describeMcpRoute({
      tags: ["Automations"], operationId: "listAutomations", "x-mcp": true,
      summary: "List Automations", description: routeDescription,
      responses: { 200: jsonResponse("Automations returned.", automationListSchema), 401: jsonResponse("Sign-in required.", unauthorizedSchema) },
    }),
    orgMemberRoute(), queryValidator(paginationSchema),
    async (c) => {
      const page = await service.list(scope(c), c.req.valid("query"))
      return c.json(sharingOn(c) ? { ...page, items: await withAutomationAccess(caller(c), page.items) } : page)
    },
  )

  app.get(
    "/v1/shared-automations",
    describeMcpRoute({
      tags: ["Automations"], operationId: "listSharedAutomations", "x-mcp": true,
      summary: "List Automations shared with the caller's teams",
      description: "Automations other members shared with a team the caller is on, newest first. Each item's access.role says what the caller may do: "
        + "view (read it, its runs and results) or manage (also pause, resume and run it, and cancel a run). A shared Automation keeps running with its "
        + "owner's accounts and models; only the owner edits, archives or shares it. The caller's own Automations are in listAutomations.",
      responses: {
        200: jsonResponse("Shared Automations returned.", automationListSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Sharing Automations with teams is not available.", notFoundSchema),
      },
    }),
    orgMemberRoute(), requireFeature("automationTeamSharing"), queryValidator(paginationSchema),
    async (c) => {
      const page = await service.listShared(scope(c), c.req.valid("query"))
      return c.json({ ...page, items: await withAutomationAccess(caller(c), page.items) })
    },
  )

  app.post(
    "/v1/automations",
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "createAutomation", "x-mcp": false,
      summary: "Create an active Automation from an app surface",
      description: `${routeDescription} This route creates Desktop Automations for first-party OpenWork clients, Desktop and Web alike. Agents must use createCloudAutomation so they cannot accidentally create Desktop placement.`,
      responses: {
        201: jsonResponse("Active Automation created.", automationDetailSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        403: jsonResponse("OpenWork Web access is required.", openWorkWebAccessRequiredSchema),
        409: jsonResponse("Cloud runtime or model access is unavailable.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(createAutomationSchema),
    async (c) => {
      try {
        return c.json(await service.create(scope(c), c.req.valid("json")), 201)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.post(
    "/v1/cloud-automations",
    describeMcpRoute({
      tags: ["Automations"], operationId: "createCloudAutomation", "x-mcp": true,
      summary: "Create an active OpenWork Cloud Automation",
      description: `${routeDescription} This is the Web and Cloud Chat creation surface. Placement is fixed to OpenWork Cloud and the Automation can wake a stopped Cloud container without a desktop. Create only when the person explicitly asks to create or schedule it; there is no draft step.`,
      responses: {
        201: jsonResponse("Active Cloud Automation created.", automationDetailSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        403: jsonResponse("OpenWork Web access is required.", openWorkWebAccessRequiredSchema),
        409: jsonResponse("Cloud runtime or model access is unavailable.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(createCloudAutomationSchema),
    async (c) => {
      try {
        return c.json(await service.create(scope(c), c.req.valid("json")), 201)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.get(
    "/v1/automations/:id",
    describeMcpRoute({
      tags: ["Automations"], operationId: "getAutomation", "x-mcp": true,
      summary: "Get an Automation", description: routeDescription,
      responses: { 200: jsonResponse("Automation returned.", automationDetailSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema),
    async (c) => {
      const id = c.req.valid("param").id
      const access = await automationAccess(c, id, "view")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      const item = await service.get(access.scope, id)
      return item ? c.json(await described(c, item)) : c.json({ error: "automation_not_found" }, 404)
    },
  )

  app.patch(
    "/v1/automations/:id",
    describeMcpRoute({
      tags: ["Automations"], operationId: "updateAutomation", "x-mcp": true,
      summary: "Update an Automation",
      description: `${routeDescription} Every behavior-changing edit creates an immutable revision and applies it to future runs immediately. `
        + "Set executionTarget to move the Automation between the owner's desktops and OpenWork Cloud; agents may move it to the cloud only.",
      responses: {
        200: jsonResponse("Automation updated.", automationDetailSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("OpenWork Web access is required for Cloud Automations.", openWorkWebAccessRequiredSchema),
        409: jsonResponse("Cloud runtime or model access is unavailable.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema), jsonValidator(updateAutomationSchema),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const access = await automationAccess(c, id, "owner")
        if (!access.ok) return c.json(access.denied.body, access.denied.status)
        const item = await service.update(access.scope, id, c.req.valid("json"), placementOptions(c))
        return item ? c.json(await described(c, item)) : c.json({ error: "automation_not_found" }, 404)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  const stateRoute = (
    path: "/v1/automations/:id/activate" | "/v1/automations/:id/deactivate",
    operationId: "activateAutomation" | "deactivateAutomation",
    action: "activate" | "deactivate",
  ) => app.post(
    path,
    describeMcpRoute({
      tags: ["Automations"], operationId, "x-mcp": true,
      summary: action === "activate" ? "Activate an Automation" : "Deactivate an Automation",
      description: routeDescription,
      responses: {
        200: jsonResponse("Automation state returned.", automationDetailSchema),
        403: action === "activate"
          ? jsonResponse("OpenWork Web access is required to activate a Cloud Automation, or the caller's team can only view it.", z.union([openWorkWebAccessRequiredSchema, automationAccessDeniedSchema]))
          : jsonResponse("The caller's team can only view this Automation.", automationAccessDeniedSchema),
        404: jsonResponse("Not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const access = await automationAccess(c, id, "manage")
        if (!access.ok) return c.json(access.denied.body, access.denied.status)
        const item = action === "activate" ? await service.activate(access.scope, id) : await service.deactivate(access.scope, id)
        return item ? c.json(await described(c, item)) : c.json({ error: "automation_not_found" }, 404)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )
  stateRoute("/v1/automations/:id/activate", "activateAutomation", "activate")
  stateRoute("/v1/automations/:id/deactivate", "deactivateAutomation", "deactivate")

  app.post(
    "/v1/automations/:id/run",
    describeMcpRoute({
      tags: ["Automations"], operationId: "runAutomationNow", "x-mcp": true,
      summary: "Run an Automation now",
      description: `${routeDescription} Send executionTarget "cloud" to run a Desktop Automation once in OpenWork Cloud without changing it. `
        + "Agents cannot run a Cloud Automation on a desktop.",
      // Optional: released clients send `{}` and agents may send no body at all.
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                executionTarget: {
                  type: "string",
                  enum: ["desktop", "cloud"],
                  description: "Run this one occurrence on this target instead of the Automation's own.",
                },
              },
            },
          },
        },
      },
      responses: {
        202: jsonResponse("Run queued.", runResponseSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("OpenWork Web access is required to run a Cloud Automation.", openWorkWebAccessRequiredSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("Cloud runtime or model access is unavailable.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema),
    async (c) => {
      const body = await runNowBody(c)
      if (!body.success) {
        return c.json({ error: "invalid_request", message: validationIssuesMessage(body.error.issues), details: body.error.issues }, 400)
      }
      try {
        // Runner presence is advisory and must not require a database
        // heartbeat. The durable claim deadline records an unclaimed desktop
        // run as missed through the same path used by scheduled occurrences.
        const id = c.req.valid("param").id
        const access = await automationAccess(c, id, "manage")
        if (!access.ok) return c.json(access.denied.body, access.denied.status)
        // Where a run executes is the owner's choice: it is their desktop or their cloud computer.
        if (access.role !== "owner" && body.data.executionTarget) return c.json(OWNER_ONLY.body, OWNER_ONLY.status)
        const run = await service.runNow(access.scope, id, {
          ...placementOptions(c),
          executionTarget: body.data.executionTarget,
        })
        if (!run) return c.json({ error: "automation_not_found" }, 404)
        addAuditRequestResource(c, { type: "automation_run", id: run.id })
        return c.json({ run }, 202)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.get(
    "/v1/automations/:id/runs",
    describeMcpRoute({
      tags: ["Automations"], operationId: "listAutomationRuns", "x-mcp": true,
      summary: "List Automation runs", description: routeDescription,
      responses: {
        200: jsonResponse("Run history returned.", runListSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Organization not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema), queryValidator(paginationSchema),
    async (c) => {
      const id = c.req.valid("param").id
      const access = await automationAccess(c, id, "view")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      return c.json(await service.listRuns(access.scope, id, c.req.valid("query")))
    },
  )

  app.get(
    "/v1/automation-runs",
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "listAutomationRunsInRange", "x-mcp": false,
      summary: "List the caller's Automation runs in a time range",
      description: `${routeDescription} Returns runs of every Automation the caller owns whose scheduled time (else start, else creation) falls in [from, to), for calendar views. At most ${AUTOMATION_RUN_RANGE_MAX_DAYS} days per request.`,
      responses: {
        200: jsonResponse("Runs in the range returned.", automationRunRangeSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(), queryValidator(automationRunRangeQuerySchema),
    async (c) => c.json(await service.listRunsInRange(scope(c), c.req.valid("query"))),
  )

  app.get(
    "/v1/automation-runs/:id",
    describeMcpRoute({
      tags: ["Automations"], operationId: "getAutomationRun", "x-mcp": true,
      summary: "Inspect an Automation run receipt and execution thread", description: routeDescription,
      responses: { 200: jsonResponse("Durable run receipt returned.", automationRunReceiptSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), paramValidator(automationRunParamsSchema),
    async (c) => {
      const id = c.req.valid("param").id
      const access = await runAccess(c, id, "view")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      const receipt = await service.getRun(access.scope, id)
      return receipt ? c.json(receipt) : c.json({ error: "automation_run_not_found" }, 404)
    },
  )

  app.post(
    "/v1/automation-runs/:id/cancel",
    describeMcpRoute({
      tags: ["Automations"], operationId: "cancelAutomationRun", "x-mcp": true,
      summary: "Cancel an active Automation run", description: routeDescription,
      responses: { 200: jsonResponse("Cancellation requested.", runResponseSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), paramValidator(automationRunParamsSchema),
    async (c) => {
      const id = c.req.valid("param").id
      const access = await runAccess(c, id, "manage")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      const member = c.get("organizationContext").currentMember
      const run = await service.cancelRun(access.scope, id, access.role === "owner" ? undefined : { memberId: member.id, userId: member.userId })
      return run ? c.json({ run }) : c.json({ error: "automation_run_not_found" }, 404)
    },
  )

  app.delete(
    "/v1/automations/:id",
    describeMcpRoute({
      tags: ["Automations"], operationId: "archiveAutomation", "x-mcp": true,
      summary: "Archive an Automation", description: `${routeDescription} Durable run history is retained.`,
      responses: { 200: jsonResponse("Automation archived.", automationDetailSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema),
    async (c) => {
      const id = c.req.valid("param").id
      const access = await automationAccess(c, id, "owner")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      const item = await service.archive(access.scope, id)
      return item ? c.json(await described(c, item)) : c.json({ error: "automation_not_found" }, 404)
    },
  )

  const sharingDescription = "The owner shares an Automation with teams they are on. A team with view access sees its instructions, schedule, runs and results; "
    + "a team with manage access can also pause, resume and run it, cancel a run, and take it over. It keeps running with the owner's accounts and models."

  app.get(
    "/v1/automations/:id/sharing",
    describeMcpRoute({
      tags: ["Automations"], operationId: "getAutomationSharing", "x-mcp": true,
      summary: "See which teams an Automation is shared with",
      description: `${sharingDescription} Returns the teams it is shared with and the teams the owner can share it with.`,
      responses: {
        200: jsonResponse("Sharing returned.", automationSharingSchema),
        403: jsonResponse("Only the owner sees and changes sharing.", automationAccessDeniedSchema),
        404: jsonResponse("Not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), requireFeature("automationTeamSharing"), paramValidator(idParamsSchema),
    async (c) => {
      const id = c.req.valid("param").id
      const access = await automationAccess(c, id, "owner")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      const sharing = await readAutomationSharing({ ...caller(c), automationId: id })
      return sharing ? c.json(sharing) : c.json({ error: "automation_not_found" }, 404)
    },
  )

  app.put(
    "/v1/automations/:id/sharing/teams/:teamId",
    describeMcpRoute({
      tags: ["Automations"], operationId: "shareAutomationWithTeam", "x-mcp": true,
      summary: "Share an Automation with a team, or change that team's access",
      description: `${sharingDescription} Share only when the person asks: the team will see what the Automation did with the owner's accounts.`,
      responses: {
        200: jsonResponse("Sharing returned.", automationSharingSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("Only the owner shares, and only with teams they are on.", automationAccessDeniedSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("Shared with too many teams.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), requireFeature("automationTeamSharing"), paramValidator(teamShareParamsSchema), jsonValidator(shareAutomationWithTeamSchema),
    async (c) => {
      const { id, teamId } = c.req.valid("param")
      const access = await automationAccess(c, id, "owner")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      try {
        const sharing = await shareAutomationWithTeam({ ...caller(c), automationId: id, teamId, access: c.req.valid("json").access })
        addAuditRequestResource(c, { type: "team", id: teamId })
        return c.json(sharing)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.delete(
    "/v1/automations/:id/sharing/teams/:teamId",
    describeMcpRoute({
      tags: ["Automations"], operationId: "stopSharingAutomationWithTeam", "x-mcp": true,
      summary: "Stop sharing an Automation with a team",
      description: `${sharingDescription} The team stops seeing the Automation at once; the Automation itself is unchanged.`,
      responses: {
        200: jsonResponse("Sharing returned.", automationSharingSchema),
        403: jsonResponse("Only the owner changes sharing.", automationAccessDeniedSchema),
        404: jsonResponse("Not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), requireFeature("automationTeamSharing"), paramValidator(teamShareParamsSchema),
    async (c) => {
      const { id, teamId } = c.req.valid("param")
      const access = await automationAccess(c, id, "owner")
      if (!access.ok) return c.json(access.denied.body, access.denied.status)
      try {
        const sharing = await stopSharingAutomationWithTeam({ ...caller(c), automationId: id, teamId })
        addAuditRequestResource(c, { type: "team", id: teamId })
        return c.json(sharing)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )

  app.post(
    "/v1/automations/:id/take-over",
    // Not an agent tool: taking over makes the Automation run with the caller's own accounts and computers.
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "takeOverAutomation", "x-mcp": false,
      summary: "Become the owner of an Automation shared with manage access",
      description: "A member of a team with manage access becomes the Automation's owner. From then on it runs with their accounts, models and computers, "
        + "so it is returned paused for them to review and resume; a workspace pinned on the previous owner's computer is dropped. "
        + "Refused while a run is in progress. The teams it is shared with are kept.",
      responses: {
        200: jsonResponse("The Automation, now owned by the caller and paused.", automationDetailSchema),
        403: jsonResponse("The caller's team can only view this Automation, or the caller cannot use its Workflow.", automationAccessDeniedSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("A run is in progress, or the caller already owns it.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), requireFeature("automationTeamSharing"), paramValidator(idParamsSchema),
    async (c) => {
      try {
        const item = await service.takeOver(scope(c), c.req.valid("param").id)
        return item ? c.json(await described(c, item)) : c.json({ error: "automation_not_found" }, 404)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
    },
  )
}
