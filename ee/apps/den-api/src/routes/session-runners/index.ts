import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { streamSSE } from "hono/streaming"
import {
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_ONLY_RUNNER_CAPABILITY,
  REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
  automationDesktopRunnerRegistrationSchema,
  automationRunnerNotificationSchema,
  automationRunnerTokenResponseSchema,
  automationRunnerWorkResponseSchema,
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
} from "@openwork/types/automations"
import { jsonValidator, orgMemberRoute, paramValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, textResponse } from "../../openapi.js"
import type { AutomationService } from "../../automations/service.js"
import { automationRunnerComputerIds } from "../../automations/repository.js"
import { automationRunnerAudienceFromRequest, automationRunnerAuth } from "../../automations/runner-auth.js"
import { env } from "../../env.js"
import { organizationFeatureEnabled, requireFeature } from "../../features.js"
import { databaseRemoteSessionCommandStore, type RemoteSessionCommandStore } from "../../remote-sessions/commands.js"
import { databaseRemoteSessionRequestStore, type RemoteSessionRequestStore } from "../../remote-sessions/requests.js"
import { createRunnerProtocol, runnerRoute, runnerErrorSchema, runnerConflictResponse } from "./protocol.js"
import { sessionRunnerService, type SessionRunnerService } from "./service.js"
import {
  RUNNER_KEEPALIVE_INTERVAL_MS,
  RUNNER_NOTIFICATION_POLL_MIN_MS,
  capRunnerNotificationPollDelayForKeepalive,
  nextRunnerNotificationPollDelay,
} from "../../automations/runner-notification-poll.js"
import { appLogger } from "../../observability/logger.js"

const idParamsSchema = z.object({ id: z.string().min(1).max(160) })

export function registerSessionRunnerRoutes<T extends { Variables: Partial<OrganizationContextVariables> }>(
  app: Hono<T>,
  options: {
    service?: SessionRunnerService
    automationService?: Pick<AutomationService, "discoverDesktopRunnerWork" | "runnerNotifications">
    commandStore?: RemoteSessionCommandStore
    requestStore?: RemoteSessionRequestStore
    featureEnabled?: (organizationId: string) => Promise<boolean>
  } = {},
) {
  const service = options.service ?? sessionRunnerService
  const commandStore = options.commandStore ?? databaseRemoteSessionCommandStore
  const requestStore = options.requestStore ?? databaseRemoteSessionRequestStore
  const featureEnabled = options.featureEnabled ?? ((organizationId) => organizationFeatureEnabled(organizationId, "remoteSessionTargets"))
  const { authenticateRunner, attributeRunner } = createRunnerProtocol(service)

  const describeTokenRoute = (input: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(input)
  const ungatedRegistration: ReturnType<typeof requireFeature> = async (_c, next) => { await next() }
  const registerTokenRoute = (path: string, sessionOnly: boolean) => app.post(
    path,
    describeTokenRoute({
      tags: sessionOnly ? ["Internal"] : ["Automations"], "x-mcp": false,
      operationId: sessionOnly ? "mintSessionRunnerToken" : "mintAutomationRunnerToken",
      summary: sessionOnly ? "Connect this computer as an interactive session runner" : "Connect this desktop as an Automation runner",
      description: "Mints the existing time-limited runner-only credential. Session runners never execute scheduled Automations.",
      responses: {
        200: jsonResponse("Runner credential minted.", automationRunnerTokenResponseSchema),
        409: jsonResponse("Runner identity conflict.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(),
    sessionOnly ? requireFeature("remoteSessionTargets") : ungatedRegistration,
    jsonValidator(automationDesktopRunnerRegistrationSchema),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const scope = { organizationId: context.organization.id, ownerMemberId: context.currentMember.id }
      const body = c.req.valid("json")
      // This route can never opt into scheduling, even when the client omits
      // the marker. All other capabilities and the released registration shape
      // are preserved, including supportedExecutionTargets: ["desktop"].
      const registration = sessionOnly
        ? automationDesktopRunnerRegistrationSchema.parse({ ...body, capabilities: [...new Set([...body.capabilities, REMOTE_SESSION_ONLY_RUNNER_CAPABILITY])] })
        : body
      try {
        await service.registerDesktopRunner(scope, registration)
      } catch (error) {
        if (error instanceof Error && error.message === "automation_runner_identity_conflict") {
          return c.json({ error: error.message, message: "This desktop runner identity is already registered to a different organization member." }, 409)
        }
        throw error
      }
      return c.json(automationRunnerAuth.issue(
        { ...scope, runnerId: registration.runnerId, capabilities: registration.capabilities },
        automationRunnerAudienceFromRequest(c.req.raw, { trustedOrigins: env.publicProxyTrustedOrigins }),
      ))
    },
  )
  registerTokenRoute("/v1/session-runners/token", true)
  registerTokenRoute("/v1/automation-runners/token", false)

  const pendingRequestItems = async (identity: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    capabilities: readonly string[]
  }): Promise<Array<{ kind: "remote_session_request"; requestId: string }>> => {
    if (!identity.capabilities.includes(REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY)) return []
    const input = { organizationId: identity.organizationId, ownerMemberId: identity.ownerMemberId,
      runnerId: identity.runnerId, now: Date.now(), limit: 5 }
    const recoverable = identity.capabilities.includes(REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY)
      ? await requestStore.listRecoverableForRunner(input) : []
    const pending = recoverable.length < 5
      ? await requestStore.listPendingForRunner({ ...input, limit: 5 - recoverable.length }) : []
    return [...recoverable, ...pending].map((request) => ({ kind: "remote_session_request", requestId: request.id }))
  }

  // The released token response names this stream. Keep it alive even without
  // a scheduler; only Automation-capable runners receive scheduler hints.
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      const requestedCursor = Number(c.req.header("Last-Event-ID") ?? "0")
      let cursor = Number.isSafeInteger(requestedCursor) && requestedCursor >= 0 ? requestedCursor : 0
      return streamSSE(c, async (stream) => {
        let lastKeepaliveAt = 0
        let lastOwnerCheckAt = Date.now()
        let notificationPollDelayMs = RUNNER_NOTIFICATION_POLL_MIN_MS
        while (!stream.aborted) {
          if (Date.now() >= identity.expiresAt) break
          if (Date.now() - lastOwnerCheckAt >= 15_000) {
            if (!await service.isActiveRunnerOwner(identity)) break
            lastOwnerCheckAt = Date.now()
          }
          const notifications = options.automationService && !identity.capabilities.includes(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)
            ? await options.automationService.runnerNotifications(identity, cursor) : []
          for (const notification of notifications) {
            cursor = notification.id
            const payload = automationRunnerNotificationSchema.parse({
              type: notification.event_type === "work_available" ? "automation_work_available" : "automation_cancellation_available",
              cursor: String(notification.id),
            })
            await stream.writeSSE({ id: payload.cursor, event: payload.type, data: JSON.stringify(payload) })
          }
          if (notifications.length === 0 && Date.now() - lastKeepaliveAt >= RUNNER_KEEPALIVE_INTERVAL_MS) {
            // Idle streams deliberately avoid durable presence writes.
            await stream.writeSSE({ event: "keepalive", data: "{}" })
            lastKeepaliveAt = Date.now()
          }
          notificationPollDelayMs = nextRunnerNotificationPollDelay(notificationPollDelayMs, notifications.length > 0)
          await stream.sleep(capRunnerNotificationPollDelayForKeepalive(notificationPollDelayMs, Date.now() - lastKeepaliveAt))
        }
      })
    },
  )

  const registerWorkRoute = (path: string, includeAutomations: boolean) => app.get(
    path,
    runnerRoute({
      summary: "Discover Automation runner work",
      description: "Returns the runs and remote-session commands currently assignable to this runner.",
      responses: { 200: jsonResponse("Available work items.", automationRunnerWorkResponseSchema) },
    }),
    async (c) => {
      const identity = await authenticateRunner(c)
      if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      // Released Automation work items keep their wire shape. Remote item kinds
      // require their advertised capabilities; short control requests go first.
      try {
        await service.touchDesktopRunner(identity)
      } catch (error) {
        appLogger.warn("session runner presence update failed", { error, organization_id: identity.organizationId, owner_member_id: identity.ownerMemberId })
      }
      const automationItems = includeAutomations && options.automationService
        && !identity.capabilities.includes(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)
        ? await options.automationService.discoverDesktopRunnerWork(identity) : []
      const requestItems = await pendingRequestItems(identity)
      const items: Array<
        | (typeof automationItems)[number]
        | { kind: "remote_session_create"; commandId: string }
        | { kind: "remote_session_request"; requestId: string }
      > = [...requestItems, ...automationItems]
      if (identity.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY)) {
        const input = { organizationId: identity.organizationId, ownerMemberId: identity.ownerMemberId,
          runnerId: identity.runnerId, now: Date.now(), limit: 5 }
        const recoverable = identity.capabilities.includes(REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY)
          ? await commandStore.listRecoverableForRunner(input) : []
        const pending = recoverable.length < 5 && await featureEnabled(identity.organizationId)
          ? await commandStore.listPendingForRunner({ ...input, computerIds: automationRunnerComputerIds(identity), limit: 5 - recoverable.length }) : []
        for (const command of [...recoverable, ...pending]) {
          items.push({ kind: "remote_session_create", commandId: command.id })
        }
      }
      return c.json(automationRunnerWorkResponseSchema.parse({ items }))
    },
  )
  registerWorkRoute("/v1/session-runners/work", false)
  registerWorkRoute("/v1/automation-runner/work", true)

  const registerInventoryRoute = (path: string) => app.put(
    path,
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      const stored = await service.saveDesktopRunnerInventory(identity, c.req.valid("json"))
      if (!stored) return c.json({ error: "runner_not_registered" }, 404)
      return c.json(desktopRunnerInventoryResponseSchema.parse({ ok: true, updatedAt: Date.now() }))
    },
  )
  registerInventoryRoute("/v1/session-runners/inventory")
  registerInventoryRoute("/v1/automation-runner/inventory")

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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
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
        recoverClaimed: identity.capabilities.includes(REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY),
        allowPending: await featureEnabled(identity.organizationId),
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
          // Unpinned commands keep their long-standing assignment shape.
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      if (!identity.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY)) {
        return c.json({ error: "runner_capability_missing" }, 403)
      }
      const command = await commandStore.complete({
        commandId: c.req.valid("param").id,
        organizationId: identity.organizationId,
        ownerMemberId: identity.ownerMemberId,
        runnerId: identity.runnerId,
        now: Date.now(),
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
      if (!identity.capabilities.includes(REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY)) {
        return c.json({ error: "runner_capability_missing" }, 403)
      }
      const request = await requestStore.claim({
        requestId: c.req.valid("param").id,
        organizationId: identity.organizationId,
        ownerMemberId: identity.ownerMemberId,
        runnerId: identity.runnerId,
        now: Date.now(),
        recoverClaimed: identity.capabilities.includes(REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY),
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
      const audited = await attributeRunner(c, identity)
      if (!audited.ok) return audited.response
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
      // The request store records the receipt and first-turn reset atomically.
      // Duplicate completions do not reset progress again.
      return c.json(remoteSessionRequestCompleteResponseSchema.parse({
        request: { id: request.id, status: request.status },
      }))
    },
  )

}
