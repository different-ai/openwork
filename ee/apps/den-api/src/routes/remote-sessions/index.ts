import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { remoteSessionStatusRequestSchema, remoteSessionStatusResultSchema, type RemoteSessionReadResult } from "@openwork/types/automations"
import {
  boundRemoteSessionsResponseSchema,
  memberSessionListResponseSchema,
  remoteSessionAttachRequestSchema,
  remoteSessionAttachResponseSchema,
  remoteSessionStreamSnapshotEventSchema,
  remoteSessionStreamUpdateEventSchema,
  remoteSessionTailResponseSchema,
} from "@openwork/types/den/remote-sessions"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, textResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrganizationContext } from "../../orgs.js"
import {
  executeRemoteSessionCapability,
  listBoundRemoteSessions,
  listMemberRemoteSessions,
  remoteSessionAnswerBodySchema,
  remoteSessionReadBodySchema,
  remoteSessionSendBodySchema,
  remoteSessionStopBodySchema,
  type RemoteSessionAction,
  type RemoteSessionExecuteDeps,
} from "../../mcp/remote-session-capabilities.js"
import { readRemoteSessionTail } from "../../remote-sessions/tails.js"
import { createSignalWaiter, hasRemoteSessionSignalPubSub, onRemoteSessionUserUpdate } from "../../remote-sessions/work-signal.js"

const WAITING_STATUS_CALLS_PER_MEMBER = 4
const STREAM_ACTIVE_FALLBACK_MS = 2_000
const STREAM_IDLE_FALLBACK_MS = 5_000
const STREAM_REDIS_FALLBACK_MS = 15_000
const STREAM_KEEPALIVE_MS = 25_000

const boundQuerySchema = z.object({
  parentSessionId: z.string().trim().min(1).max(240).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
const tailParamsSchema = z.object({
  threadKey: z.string().trim().min(1).max(280),
})

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
  409: jsonResponse("The task cannot do that now. remote_access_off: the computer takes nothing from other devices (its owner's choice, no choice yet under the organization's opt-in, or the organization's ceiling); the message says who can allow it.", remoteSessionErrorSchema),
  503: jsonResponse("The computer or cloud workspace that runs the task can't be reached right now; retry.", remoteSessionErrorSchema),
}

function httpStatus(payload: Record<string, unknown>): 200 | 400 | 404 | 409 | 503 {
  const code = payload.error
  if (typeof code !== "string") return 200
  if (code === "invalid_capability_arguments") return 400
  if (code.startsWith("unknown_") || code === "feature_disabled") return 404
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
      description: "The member answers a question or permission one of their remote sessions waits on: the chosen option labels per question, decision once or reject (never always), or kind dismiss to close a question without answering it. requestId names the open request the member saw, any of those a read lists; one that is no longer open answers 409 stale_request and nothing is sent. A computer that cannot dismiss a question answers 409 answer_unsupported. A desktop that has not answered within about 20 seconds returns state pending with a requestId to read later. Same result as the remote-session:answer capability.",
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

  app.post(
    "/v1/remote-sessions/attach",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Attach to a session started on one of the member's computers",
      description: "Makes a session that was started on one of the member's own computers reachable from other devices, like one started remotely. The organization's ceiling and that computer's owner must both allow every session; otherwise 409 session_access_denied and nothing is queued. Returns state attached with the commandId that already reaches the session, or queued with a commandId to follow through status until the computer has attached. Repeating the call returns the same command. Other refusals: 404 unknown_computer (not one of the member's computers), 409 remote_access_off (the computer, or the organization, takes nothing from other devices), 409 desktop_update_required, 503 desktop_offline. Same result as the remote-session:attach capability. Requires active membership and a session-access-capable computer whose owner and organization both allow all sessions.",
      "x-mcp": false,
      responses: { 200: jsonResponse("The session is attached, or the attach is queued.", remoteSessionAttachResponseSchema), ...commonResponses },
    }),
    orgMemberRoute(),
    jsonValidator(remoteSessionAttachRequestSchema.meta({ ref: "RemoteSessionAttachRequest" })),
    async (c) => {
      const result = await run(c.get("organizationContext"), c.req.raw.signal, "attach", c.req.valid("json"))
      c.header("Cache-Control", "no-store")
      return c.json(result.payload, result.status)
    },
  )

  app.get(
    "/v1/sessions",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "List the member's sessions across their computers",
      description: "The signed-in member's own sessions, newest first, and the computers they are on. reach reachable: read, follow up, stop and answer it through its commandId and sessionId. connecting: a start or an attach is queued for the computer. attachable: the computer reports a session that was started on it, listed only while the organization's ceiling and that computer's owner both allow every session; attach first. Each computer says what applies there: chosen (its owner has chosen on it), access (their choice, or until they choose off under the organization's opt-in and created without it) and effectiveAccess (that capped by the ceiling). optIn says whether the opt-in applies. Sessions on a computer whose effectiveAccess is off are left out until it is allowed again. Never lists another member's computers or sessions. Requires active organization membership; the organization ceiling, computer owner choice, and supported runner capabilities still constrain every session.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("The member's computers and sessions.", memberSessionListResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: jsonResponse("The organization was not found, or it uses neither sessions on members' computers nor the opt-in for tasks from other devices.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      c.header("Cache-Control", "no-store")
      return c.json(memberSessionListResponseSchema.parse(await listMemberRemoteSessions(
        { organizationId: context.organization.id, userId: context.currentMember.userId },
        options.deps,
      )))
    },
  )

  app.get(
    "/v1/remote-sessions/bound",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "List the member's bound remote sessions",
      description: "Returns the signed-in member's remote sessions bound to parent chats (optionally filtered by parentSessionId), with their latest status, computer label, and tail timestamp. Feature-gated behind remoteSessionLiveSync.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Bound remote sessions.", boundRemoteSessionsResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: jsonResponse("Organization not found or feature disabled.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteSessionLiveSync"),
    queryValidator(boundQuerySchema),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const query = c.req.valid("query")
      const sessions = await listBoundRemoteSessions({
        organizationId: context.organization.id,
        userId: context.currentMember.userId,
        ...(query.parentSessionId ? { parentSessionId: query.parentSessionId } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }, options.deps)
      c.header("Cache-Control", "no-store")
      return c.json(boundRemoteSessionsResponseSchema.parse({ sessions }))
    },
  )

  app.get(
    "/v1/remote-sessions/tail/:threadKey",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Read the stored transcript tail of a remote session",
      description: "Returns the short-lived Den-stored transcript tail (last 20 messages, 32 KB cap, 24 h expiry) for one of the signed-in member's remote sessions. Feature-gated behind remoteSessionLiveSync.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("The stored tail, or null when none is cached.", remoteSessionTailResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: jsonResponse("Organization not found or feature disabled.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteSessionLiveSync"),
    paramValidator(tailParamsSchema),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const threadKey = decodeURIComponent(c.req.valid("param").threadKey)
      const stored = await readRemoteSessionTail({
        organizationId: context.organization.id,
        createdByUserId: context.currentMember.userId,
        threadKey,
      })
      c.header("Cache-Control", "no-store")
      return c.json(remoteSessionTailResponseSchema.parse({
        threadKey,
        tail: stored?.payload ?? null,
        updatedAt: stored?.updatedAt ?? null,
        expiresAt: stored?.expiresAt ?? null,
      }))
    },
  )

  app.get(
    "/v1/remote-sessions/stream",
    describeMemberRoute({
      tags: ["Automations"],
      summary: "Stream live status and tail updates for the member's remote sessions",
      description: "One server-sent events stream per signed-in window pushing bound remote session status, computer labels, and recent transcript tail updates. Feature-gated behind remoteSessionLiveSync.",
      "x-mcp": false,
      responses: {
        200: textResponse("Server-sent event stream (text/event-stream)."),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: jsonResponse("Organization not found or feature disabled.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteSessionLiveSync"),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const organizationId = context.organization.id
      const userId = context.currentMember.userId
      c.header("Cache-Control", "no-store")
      return streamSSE(c, async (stream) => {
        const waiter = createSignalWaiter((wake) => onRemoteSessionUserUpdate(organizationId, userId, wake))
        let lastKeepaliveAt = Date.now()
        const seen = new Map<string, { version: string; tailUpdatedAt: number | null }>()
        try {
          const initial = await listBoundRemoteSessions({ organizationId, userId, limit: 50 }, options.deps)
          for (const session of initial) {
            seen.set(session.threadKey, { version: session.status.version, tailUpdatedAt: session.tailUpdatedAt })
          }
          const snapshot = remoteSessionStreamSnapshotEventSchema.parse({ type: "snapshot", sessions: initial })
          await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) })
          let hasActive = initial.some((item) => item.status.state !== "idle" && item.status.state !== "error")

          while (!stream.aborted) {
            const pollMs = hasRemoteSessionSignalPubSub()
              ? STREAM_REDIS_FALLBACK_MS
              : hasActive ? STREAM_ACTIVE_FALLBACK_MS : STREAM_IDLE_FALLBACK_MS
            await waiter.wait(Math.min(pollMs, Math.max(100, STREAM_KEEPALIVE_MS - (Date.now() - lastKeepaliveAt))), c.req.raw.signal)
            if (stream.aborted || c.req.raw.signal.aborted) break

            const latest = await listBoundRemoteSessions({ organizationId, userId, limit: 50 }, options.deps)
            hasActive = latest.some((item) => item.status.state !== "idle" && item.status.state !== "error")
            const changed = []
            const tailKeysToRead: string[] = []
            for (const session of latest) {
              const previous = seen.get(session.threadKey)
              const versionChanged = !previous || previous.version !== session.status.version
              const tailChanged = session.tailUpdatedAt !== null && (!previous || previous.tailUpdatedAt !== session.tailUpdatedAt)
              if (versionChanged || tailChanged) {
                changed.push(session)
                if (tailChanged) tailKeysToRead.push(session.threadKey)
              }
              seen.set(session.threadKey, { version: session.status.version, tailUpdatedAt: session.tailUpdatedAt })
            }
            if (changed.length > 0) {
              const tails: Record<string, RemoteSessionReadResult> = {}
              for (const key of tailKeysToRead.slice(0, 5)) {
                const stored = await readRemoteSessionTail({ organizationId, createdByUserId: userId, threadKey: key })
                if (stored) tails[key] = stored.payload
              }
              const update = remoteSessionStreamUpdateEventSchema.parse({
                type: "update",
                sessions: changed,
                ...(Object.keys(tails).length > 0 ? { tails } : {}),
              })
              await stream.writeSSE({ event: "update", data: JSON.stringify(update) })
              lastKeepaliveAt = Date.now()
            } else if (Date.now() - lastKeepaliveAt >= STREAM_KEEPALIVE_MS) {
              await stream.writeSSE({ event: "keepalive", data: "{}" })
              lastKeepaliveAt = Date.now()
            }
          }
        } finally {
          waiter.dispose()
        }
      })
    },
  )
}
