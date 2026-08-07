import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { streamSSE } from "hono/streaming"
import {
  automationDesktopRunnerAssignmentSchema,
  automationDesktopRunnerRegistrationSchema,
  automationDesktopRunnerResultSchema,
  automationDetailSchema,
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
  updateAutomationSchema,
} from "@openwork/types/automations"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  queryValidator,
  type OrganizationContextVariables,
} from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { automationService, type AutomationService } from "../../automations/service.js"
import { automationRunnerAuth } from "../../automations/runner-auth.js"
import {
  RUNNER_KEEPALIVE_INTERVAL_MS,
  RUNNER_NOTIFICATION_POLL_MIN_MS,
  capRunnerNotificationPollDelayForKeepalive,
  nextRunnerNotificationPollDelay,
} from "../../automations/runner-notification-poll.js"

const idParamsSchema = z.object({ id: z.string().min(1).max(160) })
const automationRunParamsSchema = z.object({ id: z.string().min(1).max(160) })
const paginationSchema = z.object({
  cursor: z.string().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
const runListSchema = z.object({ items: z.array(automationRunSchema), nextCursor: z.string().nullable() })
const runResponseSchema = z.object({ run: automationRunSchema })
const runnerClaimResponseSchema = z.object({ assignment: automationDesktopRunnerAssignmentSchema.nullable() })

type McpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": true }
const describeMcpRoute = (options: McpDescribeRouteOptions) => describeRoute(options)
// Runner-credential routes must never surface as MCP tools; an MCP caller with
// write scope could otherwise mint a desktop-runner bearer credential.
type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

type RouteVariables = Partial<OrganizationContextVariables>

function scope(c: { get(name: "organizationContext"): OrganizationContextVariables["organizationContext"] }) {
  const context = c.get("organizationContext")
  return { organizationId: context.organization.id, ownerMemberId: context.currentMember.id }
}

function failure(error: unknown): { status: 400 | 403 | 404 | 409; body: { error: string; message?: string } } | null {
  if (!(error instanceof Error)) return null
  if (error.message === "automation_not_found") return { status: 404, body: { error: "automation_not_found" } }
  if (["owner_membership_lost", "model_access_lost", "provider_unavailable"].includes(error.name)) {
    return { status: 409, body: { error: error.name, message: error.message } }
  }
  return null
}

const routeDescription = [
  "Den schedules Automations and keeps durable run history; execution is dispatched to the owner's connected desktop app.",
  "If no desktop runner is connected when an occurrence is due, that occurrence is recorded as missed.",
  "Creation makes an Automation active immediately and uses the owner's current OpenWork Connect integrations.",
  "Deactivation stops future runs but does not cancel a run already in progress.",
].join(" ")

export function registerAutomationRoutes<T extends { Variables: RouteVariables }>(
  app: Hono<T>,
  options: { service?: AutomationService; enabled?: boolean } = {},
) {
  if (options.enabled === false) return
  const service = options.service ?? automationService

  app.post(
    "/v1/automation-runners/token",
    describeNonMcpRoute({
      tags: ["Automations"], operationId: "mintAutomationRunnerToken", "x-mcp": false,
      summary: "Connect this desktop as an Automation runner",
      description: "Mints a time-limited runner-only credential for the desktop SSE connection and HTTP runner APIs.",
      responses: { 200: jsonResponse("Runner credential minted.", automationRunnerTokenResponseSchema) },
    }),
    orgMemberRoute(), jsonValidator(automationDesktopRunnerRegistrationSchema),
    async (c) => {
      const registration = c.req.valid("json")
      await service.registerDesktopRunner(scope(c), registration)
      return c.json(automationRunnerAuth.issue({ ...scope(c), runnerId: registration.runnerId }))
    },
  )

  // Runner tokens are stateless 12h credentials, so authorization is re-derived
  // per request: a signed token is honored only while its owner remains an
  // active organization member.
  const authenticateRunner = async (c: { req: { header(name: string): string | undefined } }) => {
    const identity = automationRunnerAuth.authenticate(c.req.header("Authorization"))
    if (!identity) return null
    return (await service.isActiveRunnerOwner(identity)) ? identity : null
  }

  app.get("/v1/automation-runners/events", async (c) => {
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
          await service.touchDesktopRunner(identity)
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
  })

  app.get("/v1/automation-runner/work", async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    return c.json(automationRunnerWorkResponseSchema.parse({ items: await service.discoverDesktopRunnerWork(identity) }))
  })

  app.post("/v1/automation-runs/:id/claim", paramValidator(automationRunParamsSchema), async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    const assignment = await service.claimDesktopRunner(identity, c.req.valid("param").id)
    return c.json(runnerClaimResponseSchema.parse({ assignment }))
  })

  app.post("/v1/automation-runs/:id/heartbeat", paramValidator(automationRunParamsSchema), jsonValidator(automationRunnerHeartbeatRequestSchema), async (c) => {
    const identity = await authenticateRunner(c)
    if (!identity) return c.json({ error: "runner_unauthorized" }, 401)
    const heartbeat = await service.heartbeatDesktopRunner(identity, c.req.valid("param").id, c.req.valid("json").attempt)
    return heartbeat
      ? c.json(automationRunnerHeartbeatResponseSchema.parse(heartbeat))
      : c.json({ error: "runner_lease_lost" }, 409)
  })

  app.post(
    "/v1/automation-runs/:id/events",
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
    describeMcpRoute({
      tags: ["Automations"], operationId: "createAutomation", "x-mcp": true,
      summary: "Create an active Automation",
      description: `${routeDescription} There is no draft, review, or permission-grant step.`,
      responses: {
        201: jsonResponse("Active Automation created.", automationDetailSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
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
      description: `${routeDescription} Every behavior-changing edit creates an immutable revision and applies it to future runs immediately.`,
      responses: { 200: jsonResponse("Automation updated.", automationDetailSchema), 400: jsonResponse("Invalid request.", invalidRequestSchema) },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema), jsonValidator(updateAutomationSchema),
    async (c) => {
      try {
        const item = await service.update(scope(c), c.req.valid("param").id, c.req.valid("json"))
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
      responses: { 200: jsonResponse("Automation state returned.", automationDetailSchema), 404: jsonResponse("Not found.", notFoundSchema) },
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
      summary: "Run an Automation now", description: routeDescription,
      responses: { 202: jsonResponse("Run queued.", runResponseSchema), 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(), paramValidator(idParamsSchema),
    async (c) => {
      const owner = scope(c)
      if (!(await service.hasOnlineDesktopRunner(owner))) {
        return c.json({ error: "runner_unavailable", message: "No desktop runner is online" }, 409)
      }
      try {
        const run = await service.runNow(owner, c.req.valid("param").id)
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
      responses: { 200: jsonResponse("Run history returned.", runListSchema) },
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
