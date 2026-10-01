import { LIMITS, TAKEOVER_KEYS, isCloudBrowserError, type BrowserKey, type CloudBrowser } from "@openwork-ee/cloud-browser"
import type { Hono, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { jsonValidator, orgMemberRoute } from "../middleware/index.js"
import { appLogger } from "../observability/logger.js"
import { binaryResponse, invalidRequestSchema, jsonResponse, notFoundSchema, okSchema, unauthorizedSchema } from "../openapi.js"
import type { OrganizationContext } from "../orgs.js"
import type { OrgRouteVariables } from "../routes/org/shared.js"
import { cloudBrowserEnabledFor, getCloudBrowser } from "./service.js"

/**
 * The person's side of the cloud browser: a live view and take-over input for
 * sign-in hand-offs, used by Den Web. Member-scoped (each person only ever
 * reaches their own browser), never exposed as MCP operations, and never
 * returning DevTools URLs or tokens.
 */

// The agent must never reach the person's take-over input or live view.
type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

const logger = appLogger.child({ component: "cloud_browser" })

/** Live-view frames are shared while one is being taken and for this long after. */
const FRAME_REUSE_MS = 250
const MAX_INPUT_IN_FLIGHT = 4
const INPUT_BODY_MAX_BYTES = 128 * 1024

const statusSchema = z.object({
  available: z.boolean().describe("The cloud browser is on for this workspace."),
  running: z.boolean(),
  url: z.string().nullable().describe("Origin and path of the active tab; never its query or fragment."),
  title: z.string().nullable(),
}).meta({ ref: "CloudBrowserStatus" })

const unavailableSchema = z.object({
  error: z.literal("cloud_browser_unavailable"),
  message: z.string(),
}).meta({ ref: "CloudBrowserUnavailableError" })

const notRunningSchema = z.object({
  error: z.literal("cloud_browser_not_running"),
  message: z.string(),
}).meta({ ref: "CloudBrowserNotRunningError" })

const busySchema = z.object({ error: z.literal("cloud_browser_busy") }).meta({ ref: "CloudBrowserBusyError" })

const coordinate = z.number().min(0).max(10_000).describe("Viewport CSS pixels.")
const delta = z.number().min(-LIMITS.scrollDelta).max(LIMITS.scrollDelta)
const inputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: coordinate, y: coordinate, clickCount: z.number().int().min(1).max(3).optional() }),
  z.object({ type: z.literal("wheel"), x: coordinate, y: coordinate, deltaX: delta.optional(), deltaY: delta }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(LIMITS.inputText) }),
  z.object({ type: z.literal("key"), key: z.enum(TAKEOVER_KEYS) }),
])
const inputBodySchema = z.object({
  events: z.array(inputEventSchema).min(1).max(LIMITS.inputEvents),
}).meta({ ref: "CloudBrowserInputRequest" })

const UNAVAILABLE = { error: "cloud_browser_unavailable" as const, message: "The cloud browser isn't on for this workspace." }
const NOT_RUNNING = { error: "cloud_browser_not_running" as const, message: "Your cloud browser isn't running." }
const FAILED = { error: "cloud_browser_unavailable" as const, message: "Your cloud browser didn't respond. Try again." }

type FrameEntry = { promise: Promise<Buffer | null>; settledAt: number | null }

function keyOf(context: OrganizationContext): BrowserKey {
  return { organizationId: context.organization.id, memberId: context.currentMember.id }
}

function idOf(key: BrowserKey) {
  return `${key.organizationId}:${key.memberId}`
}

function failure(error: unknown) {
  if (isCloudBrowserError(error) && (error.code === "not_running" || error.code === "tab_not_found")) return { status: 409 as const, body: NOT_RUNNING }
  if (!isCloudBrowserError(error)) logger.warn("cloud browser request failed", { error })
  return { status: 503 as const, body: FAILED }
}

export function registerCloudBrowserRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  options: {
    /** Test seam; defaults to the deployment's configured cloud browser. */
    browser?: CloudBrowser | null
    memberRoute?: MiddlewareHandler<{ Variables: OrgRouteVariables }>
  } = {},
) {
  const orgMemberRouteMiddleware = options.memberRoute ?? orgMemberRoute()
  const frames = new Map<string, FrameEntry>()
  const inputInFlight = new Map<string, number>()

  /** The member's browser when the deployment configured one and the workspace turned it on. */
  function browserFor(context: OrganizationContext): CloudBrowser | null {
    const browser = options.browser === undefined ? getCloudBrowser() : options.browser
    return browser && cloudBrowserEnabledFor(context.organization.metadata) ? browser : null
  }

  /** One capture per member at a time, shared by every viewer polling it. */
  function frame(browser: CloudBrowser, key: BrowserKey): Promise<Buffer | null> {
    const id = idOf(key)
    const now = Date.now()
    const current = frames.get(id)
    if (current && (current.settledAt === null || now - current.settledAt < FRAME_REUSE_MS)) return current.promise
    const entry: FrameEntry = { promise: browser.screenshot(key, { format: "jpeg", quality: 55 }), settledAt: null }
    frames.set(id, entry)
    entry.promise.then(
      () => { entry.settledAt = Date.now() },
      () => { if (frames.get(id) === entry) frames.delete(id) },
    )
    if (frames.size > 1_000) {
      for (const [otherId, other] of frames) if (other.settledAt !== null && now - other.settledAt > 5_000) frames.delete(otherId)
    }
    return entry.promise
  }

  app.get(
    "/v1/cloud-browser",
    describeNonMcpRoute({
      tags: ["Cloud Browser"],
      operationId: "getCloudBrowser",
      "x-mcp": false,
      summary: "Read my cloud browser",
      description: "Reports whether the caller's cloud browser is available and running, and the active tab's address and title. Never starts the browser.",
      responses: {
        200: jsonResponse("Cloud browser status.", statusSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The organization was not found.", notFoundSchema),
      },
    }),
    orgMemberRouteMiddleware,
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const browser = browserFor(context)
      if (!browser) return c.json({ available: false, running: false, url: null, title: null })
      const status = await browser.status(keyOf(context)).catch((error: unknown) => {
        failure(error)
        return { running: false, url: null, title: null }
      })
      return c.json({ available: true, ...status })
    },
  )

  app.get(
    "/v1/cloud-browser/screen",
    describeNonMcpRoute({
      tags: ["Cloud Browser"],
      operationId: "getCloudBrowserScreen",
      "x-mcp": false,
      summary: "Read my cloud browser's screen",
      description: "Returns the active tab of the caller's running cloud browser as a JPEG for the live view. Never starts the browser.",
      responses: {
        200: binaryResponse("The active tab as a JPEG image.", ["image/jpeg"]),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The cloud browser is not on for this workspace.", unavailableSchema),
        409: jsonResponse("The cloud browser is not running.", notRunningSchema),
        503: jsonResponse("The cloud browser did not respond.", unavailableSchema),
      },
    }),
    orgMemberRouteMiddleware,
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const browser = browserFor(context)
      if (!browser) return c.json(UNAVAILABLE, 404)
      let image: Buffer | null
      try {
        image = await frame(browser, keyOf(context))
      } catch (error) {
        const mapped = failure(error)
        return c.json(mapped.body, mapped.status)
      }
      if (!image) return c.json(NOT_RUNNING, 409)
      c.header("Content-Type", "image/jpeg")
      c.header("Cache-Control", "no-store, private")
      c.header("Content-Length", String(image.byteLength))
      return c.body(new Uint8Array(image))
    },
  )

  app.post(
    "/v1/cloud-browser/input",
    describeNonMcpRoute({
      tags: ["Cloud Browser"],
      operationId: "postCloudBrowserInput",
      "x-mcp": false,
      summary: "Send take-over input to my cloud browser",
      description: "Forwards the caller's own clicks, scrolling, typing and keys to the active tab of their running cloud browser, in order. This is how a person signs in themselves; the input goes to the website and is not stored.",
      responses: {
        200: jsonResponse("The input was delivered.", okSchema),
        400: jsonResponse("The input events were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The cloud browser is not on for this workspace.", unavailableSchema),
        409: jsonResponse("The cloud browser is not running.", notRunningSchema),
        413: jsonResponse("The request body is too large.", invalidRequestSchema),
        429: jsonResponse("Too much input at once; send it in order.", busySchema),
        503: jsonResponse("The cloud browser did not respond.", unavailableSchema),
      },
    }),
    orgMemberRouteMiddleware,
    bodyLimit({
      maxSize: INPUT_BODY_MAX_BYTES,
      onError: (c) => c.json({ error: "invalid_request", message: "Send less input at once.", details: [] }, 413),
    }),
    jsonValidator(inputBodySchema),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const browser = browserFor(context)
      if (!browser) return c.json(UNAVAILABLE, 404)
      const key = keyOf(context)
      const id = idOf(key)
      const inFlight = inputInFlight.get(id) ?? 0
      if (inFlight >= MAX_INPUT_IN_FLIGHT) return c.json({ error: "cloud_browser_busy" }, 429)
      inputInFlight.set(id, inFlight + 1)
      try {
        await browser.input(key, c.req.valid("json").events)
        return c.json({ ok: true })
      } catch (error) {
        if (isCloudBrowserError(error) && error.code === "invalid_action") {
          return c.json({ error: "invalid_request", message: error.message, details: [] }, 400)
        }
        const mapped = failure(error)
        return c.json(mapped.body, mapped.status)
      } finally {
        const remaining = (inputInFlight.get(id) ?? 1) - 1
        if (remaining > 0) inputInFlight.set(id, remaining)
        else inputInFlight.delete(id)
      }
    },
  )

  app.post(
    "/v1/cloud-browser/done",
    describeNonMcpRoute({
      tags: ["Cloud Browser"],
      operationId: "postCloudBrowserDone",
      "x-mcp": false,
      summary: "Finish taking over my cloud browser",
      description: "Called when the person is done in their cloud browser. Keeps the sign-ins they just made for next time by making the site's session cookies persistent.",
      responses: {
        200: jsonResponse("Sign-ins are kept for next time.", okSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The cloud browser is not on for this workspace.", unavailableSchema),
        409: jsonResponse("The cloud browser is not running.", notRunningSchema),
        503: jsonResponse("The cloud browser did not respond.", unavailableSchema),
      },
    }),
    orgMemberRouteMiddleware,
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const browser = browserFor(context)
      if (!browser) return c.json(UNAVAILABLE, 404)
      try {
        await browser.rememberLogins(keyOf(context))
        return c.json({ ok: true })
      } catch (error) {
        const mapped = failure(error)
        return c.json(mapped.body, mapped.status)
      }
    },
  )
}
