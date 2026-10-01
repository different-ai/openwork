import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { invalidRequestSchema, jsonResponse, textResponse, unauthorizedSchema } from "../openapi.js"
import { jsonValidator, orgMemberRoute, queryValidator, type OrganizationContextVariables } from "../middleware/index.js"
import type { AuthContextVariables } from "../session.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import {
  readWorkbotFile,
  readWorkbotThread,
  sendWorkbotMessage,
  stopWorkbot,
  workbotEnabled,
  WorkbotUnavailableError,
  type WorkbotActor,
} from "./service.js"

// The page talks to these; an agent never should, so none of them is an MCP operation.
type WorkbotRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeWorkbotRoute = (options: WorkbotRouteOptions) => describeRoute(options)

const stepSchema = z.object({ label: z.string(), status: z.enum(["running", "done", "error"]) })
const turnSchema = z.object({
  id: z.string(),
  text: z.string(),
  sentAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  status: z.enum(["queued", "working", "done", "failed", "stopped"]),
  reply: z.string(),
  activity: z.string().nullable(),
  steps: z.array(stepSchema),
  files: z.array(z.string()),
  automationIds: z.array(z.string()),
  browser: z.object({ used: z.boolean(), handedOff: z.boolean(), site: z.string().nullable() }),
  error: z.string().nullable(),
}).meta({ ref: "WorkbotTurn" })
const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  schedule: z.record(z.string(), z.unknown()),
  nextDueAt: z.number().nullable(),
  runs: z.array(z.object({
    id: z.string(),
    status: z.string(),
    finishedAt: z.number().nullable(),
    resultSummary: z.string().nullable(),
    error: z.string().nullable(),
  })),
}).meta({ ref: "WorkbotAutomation" })
const workbotResponseSchema = z.union([
  z.object({ available: z.literal(false), reason: z.enum(["workbot_not_enabled", "workbot_runner_unavailable"]) }),
  z.object({
    available: z.literal(true),
    name: z.string(),
    organizationName: z.string(),
    status: z.enum(["idle", "busy"]),
    turns: z.array(turnSchema),
    automations: z.array(automationSchema),
  }),
]).meta({ ref: "WorkbotThread" })

const sendSchema = z.object({
  /** The page's id for this message; resending it never starts a second answer. */
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  text: z.string().trim().min(1).max(20_000),
  timeZone: z.string().max(64).optional(),
}).strict()
const fileQuerySchema = z.object({ path: z.string().min(1).max(200) })

/** Plenty for a person typing; stops a runaway script from spending the organization's model budget. */
const MESSAGES_PER_WINDOW = 30
const MESSAGE_WINDOW_MS = 10 * 60_000

type Variables = AuthContextVariables & Partial<OrganizationContextVariables>

function actorOf(c: { get(key: "organizationContext"): Variables["organizationContext"]; get(key: "user"): Variables["user"] }): WorkbotActor | null {
  const context = c.get("organizationContext")
  if (!context) return null
  const name = c.get("user")?.name?.trim()
  return {
    organizationId: context.organization.id,
    organizationName: context.organization.name,
    organizationMetadata: context.organization.metadata,
    memberId: context.currentMember.id,
    userId: context.currentMember.userId,
    firstName: name ? name.split(/\s+/)[0] ?? null : null,
  }
}

const unavailable = (code: WorkbotUnavailableError["code"]) => ({ available: false as const, reason: code })

export function registerWorkbotRoutes<T extends { Variables: Variables }>(app: Hono<T>) {
  app.get(
    "/v1/workbot",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "getWorkbotThread",
      "x-mcp": false,
      summary: "Read my Workbot conversation",
      description: "The signed-in member's one Workbot conversation: their messages, answers, drafts and the schedules it set up.",
      responses: {
        200: jsonResponse("The conversation, or why Workbot is unavailable.", workbotResponseSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json(unavailable("workbot_not_enabled"))
      try {
        return c.json({ available: true as const, ...await readWorkbotThread(actor) })
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json(unavailable(error.code))
        throw error
      }
    },
  )

  app.post(
    "/v1/workbot/messages",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "sendWorkbotMessage",
      "x-mcp": false,
      summary: "Send a message to Workbot",
      description: "Adds a message to the member's conversation. Messages sent while Workbot is working are answered in order.",
      responses: {
        202: jsonResponse("Accepted.", z.object({ ok: z.literal(true) })),
        400: jsonResponse("Invalid message.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot is unavailable.", z.object({ error: z.string() })),
        429: jsonResponse("Too many messages are waiting, or sent too quickly.", z.object({ error: z.enum(["too_many_queued", "rate_limited"]), retryAfter: z.number().optional() })),
      },
    }),
    orgMemberRoute(),
    jsonValidator(sendSchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      const retryAfter = await checkRateLimit(`workbot:${actor.organizationId}:${actor.memberId}`, MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
      try {
        const sent = await sendWorkbotMessage(actor, c.req.valid("json"))
        if (!sent.ok) return c.json({ error: sent.code }, 429)
        return c.json({ ok: true as const }, 202)
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.post(
    "/v1/workbot/stop",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "stopWorkbot",
      "x-mcp": false,
      summary: "Stop Workbot",
      description: "Stops the answer in progress and any messages waiting behind it.",
      responses: {
        200: jsonResponse("Stopped.", z.object({ stopped: z.boolean() })),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot is unavailable.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      try {
        return c.json(await stopWorkbot(actor))
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.get(
    "/v1/workbot/files/content",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "readWorkbotFile",
      "x-mcp": false,
      summary: "Open a Workbot draft",
      description: "The text of a draft Workbot wrote in the member's conversation.",
      responses: {
        200: textResponse("The draft."),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("No such draft.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    queryValidator(fileQuerySchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "not_found" }, 404)
      try {
        const content = await readWorkbotFile(actor, c.req.valid("query").path)
        return content === null ? c.json({ error: "not_found" }, 404) : c.text(content)
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json({ error: "not_found" }, 404)
        throw error
      }
    },
  )
}
