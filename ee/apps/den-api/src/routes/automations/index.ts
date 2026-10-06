import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { streamSSE } from "hono/streaming"
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  automationDesktopRunnerAssignmentSchema,
  automationDesktopRunnerRegistrationSchema,
  automationDesktopRunnerPresenceSchema,
  automationDesktopRunnerResultSchema,
  automationDetailSchema,
  automationExecutionTargetListSchema,
  automationListSchema,
  automationRunReceiptSchema,
  automationRunSchema,
  automationRunnerEventRequestSchema,
  automationRunnerHeartbeatRequestSchema,
  automationRunnerHeartbeatResponseSchema,
  automationRunnerNotificationSchema,
  automationRunnerTokenResponseSchema,
  automationRunnerWorkResponseSchema,
  createAutomationSchema,
  createCloudAutomationSchema,
  desktopRunnerInventoryResponseSchema,
  desktopRunnerInventorySchema,
  remoteSessionCommandClaimResponseSchema,
  remoteSessionCommandCompleteRequestSchema,
  remoteSessionCommandCompleteResponseSchema,
  remoteSessionCommandSessionReportResponseSchema,
  remoteSessionCommandSessionReportSchema,
  remoteSessionRequestClaimResponseSchema,
  remoteSessionRequestCompleteRequestSchema,
  remoteSessionRequestCompleteResponseSchema,
  remoteSessionRequestPendingResponseSchema,
  runAutomationNowSchema,
  updateAutomationSchema,
} from "@openwork/types/automations"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  queryValidator,
  validationIssuesMessage,
  type OrganizationContextVariables,
} from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, textResponse, unauthorizedSchema } from "../../openapi.js"
import { automationService, type AutomationService } from "../../automations/service.js"
import { automationRunnerComputerIds } from "../../automations/repository.js"
import { automationRunnerAudienceFromRequest, automationRunnerAuth } from "../../automations/runner-auth.js"
import { env } from "../../env.js"
import { OpenWorkWebAccessRequiredError } from "../../openwork-web-runtime-access.js"
import { databaseRemoteSessionCommandStore, type RemoteSessionCommandStore } from "../../remote-sessions/commands.js"
import { databaseRemoteSessionRequestStore, type RemoteSessionRequestStore } from "../../remote-sessions/requests.js"
import {
  RUNNER_KEEPALIVE_INTERVAL_MS,
  RUNNER_NOTIFICATION_POLL_MIN_MS,
  capRunnerNotificationPollDelayForKeepalive,
  nextRunnerNotificationPollDelay,
} from "../../automations/runner-notification-poll.js"
import { typeId } from "@openwork-ee/utils/typeid"

const idParamsSchema = z.object({
  id: z.string().min(1).max(160).refine(
    (val) => typeId.validator("automation", val),
    { message: "Invalid automation ID: must be a valid TypeID with the 'atm_' prefix and a 26-character base32 suffix" },
  ),
})
const automationRunParamsSchema = z.object({
  id: z.string().min(1).max(160).refine(
    (val) => typeId.validator("automationRun", val),
    { message: "Invalid automation run ID: must be a valid TypeID with the 'atr_' prefix and a 26-character base32 suffix" },
  ),
})
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

function scope(c: {
  get(name: "organizationContext"): OrganizationContextVariables["organizationContext"]
  req: { header(name: string): string | undefined }
}) {
  const context = c.get("organizationContext")
  return {
    organizationId: context.organization.id,
    ownerMemberId: context.currentMember.id,
    modelAttentionCapable: c.req.header(AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER)
      === AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  }
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
  } = {},
) {
  if (options.enabled === false) return
  const service = options.service ?? automationService
  const commandStore = options.commandStore ?? databaseRemoteSessionCommandStore
  const requestStore = options.requestStore ?? databaseRemoteSessionRequestStore

  app.post(
    "/v1/automation-runners/token",
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "mintAutomationRunnerToken", "x-mcp": false,
      summary: "Connect this desktop as an Automation runner",
      description: "Mints a time-limited runner-only credential for the desktop SSE connection and HTTP runner APIs.",
      responses: {
        200: jsonResponse("Runner credential minted.", automationRunnerTokenResponseSchema),
        409: jsonResponse("Runner identity conflict.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(automationDesktopRunnerRegistrationSchema),
    async (c) => {
      const registration = c.req.valid("json")
      try {
        await service.registerDesktopRunner(scope(c), registration)
      } catch (error) {
        const mapped = failure(error)
        if (mapped) return c.json(mapped.body, mapped.status)
        throw error
      }
      return c.json(automationRunnerAuth.issue(
        {
          organizationId: scope(c).organizationId,
          ownerMemberId: scope(c).ownerMemberId,
          runnerId: registration.runnerId,
          capabilities: registration.capabilities,
        },
        automationRunnerAudienceFromRequest(c.req.raw, {
          trustedOrigins: env.publicProxyTrustedOrigins,
        }),
      ))
    },
  )

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

  // Runner tokens are stateless 12h credentials, so authorization is re-derived
  // per request: a signed token is honored only while its owner remains an
  // active organization member.
  const authenticateRunner = async (c: { req: { header(name: string): string | undefined } }) => {
    const identity = automationRunnerAuth.authenticate(c.req.header("Authorization"))
    if (!identity) return null
    return (await service.isActiveRunnerOwner(identity)) ? identity : null
  }

  // Runner protocol routes are spoken only by the signed-in desktop runner.
  // They are tagged Internal so the published snapshot excludes them while the
  // served document keeps them for debugging.
  const runnerErrorSchema = z.object({ error: z.string() })
  const runnerRoute = (input: { summary: string; description?: string; responses: DescribeRouteOptions["responses"] }) => describeRoute({
    tags: ["Internal"],
    security: [{ automationRunnerToken: [] }],
    summary: input.summary,
    description: input.description,
    responses: {
      ...input.responses,
      401: jsonResponse("The runner token was missing, expired, or its owner is no longer an active member.", runnerErrorSchema),
    },
  })
  const runnerConflictResponse = jsonResponse("The run lease was lost or the request conflicts with the run's current state.", runnerErrorSchema)

  const pendingRequestItems = async (identity: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    capabilities: readonly string[]
  }): Promise<Array<{ kind: "remote_session_request"; requestId: string }>> => {
    if (!identity.capabilities.includes(REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY)) return []
    const requests = await requestStore.listPendingForRunner({
      organizationId: identity.organizationId,
      ownerMemberId: identity.ownerMemberId,
      runnerId: identity.runnerId,
      now: Date.now(),
      limit: 5,
    })
    return requests.map((request) => ({ kind: "remote_session_request", requestId: request.id }))
  }

  app.get(
    "/v1/automation-runners/events",
    runnerRoute({
      summary: "Stream Automation runner notifications",
      description: "Server-sent events stream that tells a desktop runner when work or cancellations are available. Send Last-Event-ID to resume from a cursor.",
      responses: { 200: textResponse("Server-sent event stream (text/event-stream).") },
    }),
    async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    const requestedCursor = Number(c.req.header("Last-Event-ID") ?? "0")
    let cursor = Number.isSafeInteger(requestedCursor) && requestedCursor >= 0 ? requestedCursor : 0
    return streamSSE(c, async (stream) => {
      let lastKeepaliveAt = 0
      let lastOwnerCheckAt = Date.now()
      let notificationPollDelayMs = RUNNER_NOTIFICATION_POLL_MIN_MS
      while (!stream.aborted) {
        // A held-open stream must not outlive the credential or membership.
        if (Date.now() >= identity.expiresAt) break
        if (Date.now() - lastOwnerCheckAt >= 15_000) {
          if (!(await service.isActiveRunnerOwner(identity))) break
          lastOwnerCheckAt = Date.now()
        }
        const notifications = await service.runnerNotifications(identity, cursor)
        for (const notification of notifications) {
          cursor = notification.id
          const payload = automationRunnerNotificationSchema.parse({
            type: notification.event_type === "work_available"
              ? "automation_work_available"
              : "automation_cancellation_available",
            cursor: String(notification.id),
          })
          await stream.writeSSE({ id: payload.cursor, event: payload.type, data: JSON.stringify(payload) })
        }
        if (notifications.length === 0 && Date.now() - lastKeepaliveAt >= RUNNER_KEEPALIVE_INTERVAL_MS) {
          // The open SSE stream is the live presence signal. Persisting that
          // signal every 15 seconds turns every idle runner into a perpetual
          // database writer; durable runner metadata is refreshed when the
          // runner registers or actually asks for work instead.
          await stream.writeSSE({ event: "keepalive", data: "{}" })
          lastKeepaliveAt = Date.now()
        }
        notificationPollDelayMs = nextRunnerNotificationPollDelay(
          notificationPollDelayMs,
          notifications.length > 0,
        )
        // Idle runners need only a bounded recovery scan. Keep the sleep short
        // enough to preserve the existing presence heartbeat, and return to
        // the low-latency interval as soon as this stream observes activity.
        await stream.sleep(capRunnerNotificationPollDelayForKeepalive(
          notificationPollDelayMs,
          Date.now() - lastKeepaliveAt,
        ))
      }
    })
    },
  )

  app.get(
    "/v1/automation-runner/work",
    runnerRoute({
      summary: "Discover Automation runner work",
      description: "Returns the runs and remote-session commands currently assignable to this runner.",
      responses: { 200: jsonResponse("Available work items.", automationRunnerWorkResponseSchema) },
    }),
    async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    // Automation run items keep their long-standing wire shape untouched;
    // remote-session command items are only appended for runners that
    // registered the remote_session_v1 capability, so released runners never
    // see the new item kind. Session requests are listed first, and only for
    // runners that registered remote_session_control_v1: they are short and
    // interactive, and the runner answers them without taking its slot.
    const automationItems = await service.discoverDesktopRunnerWork(identity)
    const requestItems = await pendingRequestItems(identity)
    const items: Array<
      | (typeof automationItems)[number]
      | { kind: "remote_session_create"; commandId: string }
      | { kind: "remote_session_request"; requestId: string }
    > = [...requestItems, ...automationItems]
    if (identity.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY)) {
      const commands = await commandStore.listPendingForRunner({
        organizationId: identity.organizationId,
        ownerMemberId: identity.ownerMemberId,
        computerIds: automationRunnerComputerIds(identity),
        now: Date.now(),
        limit: 5,
      })
      for (const command of commands) {
        items.push({ kind: "remote_session_create", commandId: command.id })
      }
    }
    return c.json(automationRunnerWorkResponseSchema.parse({ items }))
    },
  )

  app.put(
    "/v1/automation-runner/inventory",
    runnerRoute({
      summary: "Report this desktop's computer, workspaces and models",
      description: "Replaces the runner's latest inventory. Remote-session callers read it through remote-session:targets "
        + "to choose a computer, workspace and model. Desktops send it when they connect and when it changes.",
      responses: {
        200: jsonResponse("The inventory was stored.", desktopRunnerInventoryResponseSchema),
        404: jsonResponse("The runner is not registered; register it again first.", runnerErrorSchema),
      },
    }),
    jsonValidator(desktopRunnerInventorySchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      const stored = await service.saveDesktopRunnerInventory(identity, c.req.valid("json"))
      if (!stored) return c.json({ error: "runner_not_registered" }, 404)
      return c.json(desktopRunnerInventoryResponseSchema.parse({ ok: true, updatedAt: Date.now() }))
    },
  )

  app.post(
    "/v1/remote-session-commands/:id/claim",
    runnerRoute({
      summary: "Claim a remote-session command",
      responses: {
        200: jsonResponse("The claimed command assignment.", remoteSessionCommandClaimResponseSchema),
        403: jsonResponse("The runner did not register the remote-session capability.", runnerErrorSchema),
        409: runnerConflictResponse,
      },
    }),
    paramValidator(idParamsSchema),
    async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    if (!identity.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY)) {
      return c.json({ error: "runner_capability_missing" }, 403)
    }
    const command = await commandStore.claim({
      commandId: c.req.valid("param").id,
      organizationId: identity.organizationId,
      ownerMemberId: identity.ownerMemberId,
      runnerId: identity.runnerId,
      computerIds: automationRunnerComputerIds(identity),
      now: Date.now(),
    })
    if (!command) return c.json({ error: "command_claim_conflict" }, 409)
    return c.json(remoteSessionCommandClaimResponseSchema.parse({
      assignment: {
        commandId: command.id,
        kind: "remote_session_create",
        title: command.title,
        prompt: command.prompt,
        model: command.model,
        expiresAt: command.expiresAt,
        // Only pinned commands carry the field, so the assignment of an
        // untargeted command keeps its long-standing shape.
        ...(command.targetWorkspaceId ? { workspaceId: command.targetWorkspaceId } : {}),
      },
    }))
    },
  )

  app.post(
    "/v1/remote-session-commands/:id/complete",
    runnerRoute({
      summary: "Complete a remote-session command",
      responses: {
        200: jsonResponse("The completed command.", remoteSessionCommandCompleteResponseSchema),
        403: jsonResponse("The runner did not register the remote-session capability.", runnerErrorSchema),
        409: runnerConflictResponse,
      },
    }),
    paramValidator(idParamsSchema), jsonValidator(remoteSessionCommandCompleteRequestSchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      if (!identity.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY)) {
        return c.json({ error: "runner_capability_missing" }, 403)
      }
      const command = await commandStore.complete({
        commandId: c.req.valid("param").id,
        runnerId: identity.runnerId,
        ...c.req.valid("json"),
      })
      if (!command) return c.json({ error: "command_complete_conflict" }, 409)
      return c.json(remoteSessionCommandCompleteResponseSchema.parse({
        command: {
          id: command.id,
          status: command.status,
          sessionId: command.sessionId,
          workspaceId: command.workspaceId,
        },
      }))
    },
  )

  app.post(
    "/v1/remote-session-commands/:id/session",
    runnerRoute({
      summary: "Report a delivered remote session's progress",
      responses: {
        200: jsonResponse("The report was recorded.", remoteSessionCommandSessionReportResponseSchema),
        403: jsonResponse("The runner did not register the remote-session capability.", runnerErrorSchema),
        404: jsonResponse("The command does not exist for this runner's member.", runnerErrorSchema),
        409: jsonResponse("Another runner claimed the command, or it is not delivered.", runnerErrorSchema),
      },
    }),
    paramValidator(idParamsSchema), jsonValidator(remoteSessionCommandSessionReportSchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      if (!identity.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY)) {
        return c.json({ error: "runner_capability_missing" }, 403)
      }
      const result = await commandStore.report({
        commandId: c.req.valid("param").id,
        organizationId: identity.organizationId,
        ownerMemberId: identity.ownerMemberId,
        runnerId: identity.runnerId,
        ...c.req.valid("json"),
      })
      if (result === "not_found") return c.json({ error: "command_not_found" }, 404)
      if (result === "conflict") return c.json({ error: "command_session_conflict" }, 409)
      return c.json(remoteSessionCommandSessionReportResponseSchema.parse({ ok: true }))
    },
  )

  app.get(
    "/v1/remote-session-requests/pending",
    runnerRoute({
      summary: "List remote-session requests for this runner",
      description: "A read-only poll for read, send, and stop requests addressed to this runner. "
        + "Runners without the remote_session_control_v1 capability always get an empty list.",
      responses: { 200: jsonResponse("Pending requests.", remoteSessionRequestPendingResponseSchema) },
    }),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      return c.json(remoteSessionRequestPendingResponseSchema.parse({ items: await pendingRequestItems(identity) }))
    },
  )

  app.post(
    "/v1/remote-session-requests/:id/claim",
    runnerRoute({
      summary: "Claim a remote-session request",
      responses: {
        200: jsonResponse("The claimed request assignment.", remoteSessionRequestClaimResponseSchema),
        403: jsonResponse("The runner did not register the remote-session control capability.", runnerErrorSchema),
        409: jsonResponse("The request is not addressed to this runner, already claimed, or expired.", runnerErrorSchema),
      },
    }),
    paramValidator(idParamsSchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      if (!identity.capabilities.includes(REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY)) {
        return c.json({ error: "runner_capability_missing" }, 403)
      }
      const request = await requestStore.claim({
        requestId: c.req.valid("param").id,
        organizationId: identity.organizationId,
        ownerMemberId: identity.ownerMemberId,
        runnerId: identity.runnerId,
        now: Date.now(),
      })
      if (!request) return c.json({ error: "request_claim_conflict" }, 409)
      return c.json(remoteSessionRequestClaimResponseSchema.parse({
        assignment: {
          requestId: request.id,
          kind: "remote_session_request",
          commandId: request.commandId,
          sessionId: request.sessionId,
          workspaceId: request.workspaceId,
          engine: request.engine,
          expiresAt: request.expiresAt,
          action: request.action,
          input: request.input,
        },
      }))
    },
  )

  app.post(
    "/v1/remote-session-requests/:id/complete",
    runnerRoute({
      summary: "Complete a remote-session request",
      responses: {
        200: jsonResponse("The completed request.", remoteSessionRequestCompleteResponseSchema),
        403: jsonResponse("The runner did not register the remote-session control capability.", runnerErrorSchema),
        409: jsonResponse("The request is not claimed by this runner, or the result answers another action.", runnerErrorSchema),
      },
    }),
    paramValidator(idParamsSchema), jsonValidator(remoteSessionRequestCompleteRequestSchema),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      if (!identity.capabilities.includes(REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY)) {
        return c.json({ error: "runner_capability_missing" }, 403)
      }
      const body = c.req.valid("json")
      const now = Date.now()
      const request = await requestStore.complete({
        requestId: c.req.valid("param").id,
        organizationId: identity.organizationId,
        ownerMemberId: identity.ownerMemberId,
        runnerId: identity.runnerId,
        now,
        ...body,
      })
      if (!request) return c.json({ error: "request_complete_conflict" }, 409)
      if (request.outcome?.action === "send" && !request.outcome.result.alreadyPresent) {
        // The runner restarts its progress watcher only after this returns,
        // so a fast reply can never be overwritten by this reset.
        await commandStore.markTurnStarted({ commandId: request.commandId, runnerId: identity.runnerId, now })
      }
      return c.json(remoteSessionRequestCompleteResponseSchema.parse({
        request: { id: request.id, status: request.status },
      }))
    },
  )

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
    async (c) => c.json(await service.list(scope(c), c.req.valid("query"))),
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
      const item = await service.get(scope(c), c.req.valid("param").id)
      return item ? c.json(item) : c.json({ error: "automation_not_found" }, 404)
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
        const item = await service.update(scope(c), c.req.valid("param").id, c.req.valid("json"), placementOptions(c))
        return item ? c.json(item) : c.json({ error: "automation_not_found" }, 404)
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
        ...(action === "activate" ? {
          403: jsonResponse("OpenWork Web access is required to activate a Cloud Automation.", openWorkWebAccessRequiredSchema),
        } : {}),
        404: jsonResponse("Not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const item = action === "activate" ? await service.activate(scope(c), id) : await service.deactivate(scope(c), id)
        return item ? c.json(item) : c.json({ error: "automation_not_found" }, 404)
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
        const run = await service.runNow(scope(c), c.req.valid("param").id, {
          ...placementOptions(c),
          executionTarget: body.data.executionTarget,
        })
        return run ? c.json({ run }, 202) : c.json({ error: "automation_not_found" }, 404)
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
    async (c) => c.json(await service.listRuns(scope(c), c.req.valid("param").id, c.req.valid("query"))),
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
      const receipt = await service.getRun(scope(c), c.req.valid("param").id)
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
      const run = await service.cancelRun(scope(c), c.req.valid("param").id)
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
      const item = await service.archive(scope(c), c.req.valid("param").id)
      return item ? c.json(item) : c.json({ error: "automation_not_found" }, 404)
    },
  )
}
