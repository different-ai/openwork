import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { remoteSessionStatusRequestSchema, remoteSessionStatusResultSchema } from "@openwork/types/automations"
import { jsonValidator, orgMemberRoute, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrganizationContext } from "../../orgs.js"
import {
  executeRemoteSessionCapability,
  remoteSessionAnswerBodySchema,
  remoteSessionReadBodySchema,
  remoteSessionSendBodySchema,
  remoteSessionStopBodySchema,
  type RemoteSessionAction,
  type RemoteSessionExecuteDeps,
} from "../../mcp/remote-session-capabilities.js"

/**
 * The member's own remote sessions, for OpenWork's apps. The desktop chat
 * follows a task it started on another computer through these: one batched
 * status call for every task it shows, and the transcript, follow-ups and
 * stop only when the person opens one. They run the same capabilities agents
 * call through MCP (`remote-session:*`), so both see the same receipts.
 */

/** Waiting status calls one member may hold at once; more answer immediately. */
const WAITING_STATUS_CALLS_PER_MEMBER = 4

const remoteSessionResultSchema = z.object({}).passthrough().meta({ ref: "RemoteSessionResult" })
const remoteSessionErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
}).passthrough().meta({ ref: "RemoteSessionError" })

const describeMemberRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)

const commonResponses = {
  400: jsonResponse("The request or its arguments were invalid.", z.union([invalidRequestSchema, remoteSessionErrorSchema])),
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  404: jsonResponse("The task is unknown or the organization was not found.", notFoundSchema),
  409: jsonResponse("The task cannot do that now.", remoteSessionErrorSchema),
  503: jsonResponse("The computer or cloud workspace that runs the task can't be reached right now; retry.", remoteSessionErrorSchema),
}

function httpStatus(payload: Record<string, unknown>): 200 | 400 | 404 | 409 | 503 {
  const code = payload.error
  if (typeof code !== "string") return 200
  if (code === "invalid_capability_arguments") return 400
  if (code.startsWith("unknown_")) return 404
  return payload.retryable === true ? 503 : 409
}

export function registerRemoteSessionRoutes<T extends { Variables: Partial<OrganizationContextVariables> }>(
  app: Hono<T>,
  options: { deps?: RemoteSessionExecuteDeps } = {},
) {
  const waiting = new Map<string, number>()

  async function run(context: OrganizationContext | undefined, signal: AbortSignal, action: RemoteSessionAction, body: unknown) {
    if (!context) return { payload: { error: "organization_not_found" }, status: 404 as const }
    const result = await executeRemoteSessionCapability({
      action,
      organizationId: context.organization.id,
      userId: context.currentMember.userId,
      // The member acts on their own receipts; there is no narrower token scope here.
      hasWriteScope: true,
      body,
      signal,
    }, options.deps)
    const payload = result.structuredContent ?? {}
    return { payload, status: httpStatus(payload) }
  }

  app.post(
    "/v1/remote-sessions/status",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Get the status of remote sessions",
      description: "Returns the compact status of up to ten of the member's remote sessions: Cloud sessions by sessionId, desktop and registered client tasks by commandId. Pass each version received; an unchanged session returns only its ref and version. waitMs holds the call until one changes or every one has settled. Same result as the remote-session:status capability.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("The status of each session.", remoteSessionStatusResultSchema.meta({ ref: "RemoteSessionStatusResult" })),
        ...commonResponses,
      },
    }),
    orgMemberRoute(),
    jsonValidator(remoteSessionStatusRequestSchema.meta({ ref: "RemoteSessionStatusRequest" })),
    async (c) => {
      const body = c.req.valid("json")
      const member = c.get("organizationContext")?.currentMember.id ?? ""
      const held = waiting.get(member) ?? 0
      // A client that opens more waiting calls than it needs gets plain answers, never more held requests.
      const wait = (body.waitMs ?? 0) > 0 && held < WAITING_STATUS_CALLS_PER_MEMBER
      if (wait) waiting.set(member, held + 1)
      try {
        const result = await run(c.get("organizationContext"), c.req.raw.signal, "status", wait ? body : { ...body, waitMs: 0 })
        c.header("Cache-Control", "no-store")
        return c.json(result.payload, result.status)
      } finally {
        if (wait) {
          const remaining = (waiting.get(member) ?? 1) - 1
          if (remaining > 0) waiting.set(member, remaining)
          else waiting.delete(member)
        }
      }
    },
  )

  app.post(
    "/v1/remote-sessions/read",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Read a remote session",
      description: "Returns a page of a remote session's transcript by sessionId, or a desktop task's receipt by commandId or requestId. A desktop that has not answered within about 20 seconds returns state pending with a requestId to read later. Same result as the remote-session:read capability.",
      "x-mcp": false,
      responses: { 200: jsonResponse("The transcript page or receipt.", remoteSessionResultSchema), ...commonResponses },
    }),
    orgMemberRoute(),
    jsonValidator(remoteSessionReadBodySchema),
    async (c) => {
      const result = await run(c.get("organizationContext"), c.req.raw.signal, "read", c.req.valid("json"))
      c.header("Cache-Control", "no-store")
      return c.json(result.payload, result.status)
    },
  )

  app.post(
    "/v1/remote-sessions/send",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Send a follow-up to a remote session",
      description: "Sends the member's follow-up prompt to one of their remote sessions. Returns an acceptance receipt, or state pending with a requestId when a desktop has not answered within about 20 seconds. Same result as the remote-session:send capability.",
      "x-mcp": false,
      responses: { 200: jsonResponse("The follow-up was accepted or is pending.", remoteSessionResultSchema), ...commonResponses },
    }),
    orgMemberRoute(),
    jsonValidator(remoteSessionSendBodySchema),
    async (c) => {
      const result = await run(c.get("organizationContext"), c.req.raw.signal, "send", c.req.valid("json"))
      c.header("Cache-Control", "no-store")
      return c.json(result.payload, result.status)
    },
  )

  app.post(
    "/v1/remote-sessions/answer",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Answer a remote session's question or permission",
      description: "The member answers the question or permission one of their remote sessions waits on: the chosen option labels per question, or decision once or reject (never always). requestId names the pending request the member saw; one that is no longer pending answers 409 stale_request and nothing is sent. A desktop that has not answered within about 20 seconds returns state pending with a requestId to read later. Same result as the remote-session:answer capability.",
      "x-mcp": false,
      responses: { 200: jsonResponse("The answer reached the session, or is pending.", remoteSessionResultSchema), ...commonResponses },
    }),
    orgMemberRoute(),
    jsonValidator(remoteSessionAnswerBodySchema),
    async (c) => {
      const result = await run(c.get("organizationContext"), c.req.raw.signal, "answer", c.req.valid("json"))
      c.header("Cache-Control", "no-store")
      return c.json(result.payload, result.status)
    },
  )

  app.post(
    "/v1/remote-sessions/stop",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Stop a remote session",
      description: "Stops one of the member's running remote sessions. For a desktop session pass messageId, the latest user turn, so a newer turn is never stopped. Same result as the remote-session:stop capability.",
      "x-mcp": false,
      responses: { 200: jsonResponse("Whether the session stopped, or a pending requestId.", remoteSessionResultSchema), ...commonResponses },
    }),
    orgMemberRoute(),
    jsonValidator(remoteSessionStopBodySchema),
    async (c) => {
      const result = await run(c.get("organizationContext"), c.req.raw.signal, "stop", c.req.valid("json"))
      c.header("Cache-Control", "no-store")
      return c.json(result.payload, result.status)
    },
  )
}
