import { desktopStartupReportSchema, orgDiagnosticsSchema } from "@openwork/types/den/diagnostics"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { hasDiagnosticsErrors } from "../../diagnostics/attention.js"
import { recordDesktopStartup } from "../../diagnostics/desktop-startup.js"
import { checkOrgDiagnostics, readOrgDiagnostics, type DiagnosticsCaller } from "../../diagnostics/index.js"
import { isLocalDeploymentOperator, jsonValidator, orgMemberRoute, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import { memberPermissionsForRequest, type OrgRouteVariables } from "./shared.js"

const DESKTOP_STARTUP_RATE_LIMIT = 20
const DESKTOP_STARTUP_RATE_WINDOW_MS = 3_600_000

const diagnosticsQuerySchema = z.object({
  strict: z.enum(["0", "1", "true", "false"]).optional()
    .describe("With 1 or true, answer 503 (same body) when any attention item is an error. For post-deploy smoke tests."),
})
const rateLimitedSchema = z.object({ error: z.literal("rate_limited") })

type DiagnosticsContext = {
  get: <K extends "organizationContext" | "user" | "session" | "apiKey">(key: K) => OrgRouteVariables[K]
}

async function diagnosticsCaller(c: DiagnosticsContext): Promise<DiagnosticsCaller | null> {
  const payload = c.get("organizationContext")
  const permissions = await memberPermissionsForRequest(c)
  if (!payload || !permissions) return null
  let operator: Promise<boolean> | null = null
  return {
    organizationId: payload.organization.id,
    orgMembershipId: payload.currentMember.id,
    has: (key) => permissions.has(key),
    isInstallationOperator: () => {
      operator ??= isLocalDeploymentOperator({ user: c.get("user"), session: c.get("session"), apiKey: c.get("apiKey") })
      return operator
    },
  }
}

export function registerOrgDiagnosticsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/diagnostics",
    describeRoute({
      tags: ["Diagnostics"],
      summary: "Read Settings › Diagnostics",
      description: "One read for cloud, single-org and self-hosted Den: desktop startups (last 24 hours), model providers, connectors, installation services and network diagnostics, plus a summary of what needs attention. Each section is present for every caller; a section the caller's permissions do not open is `locked` and names the permission. Installation details are only for self-hosted installation administrators (local allowlist). Never returns credentials, upstream responses or another member's identity. Missing or expired provider and connector checks start in the background (rate limited); the read never waits for them.",
      responses: {
        200: jsonResponse("Diagnostics for this caller.", orgDiagnosticsSchema),
        400: jsonResponse("The query was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("No active organization.", notFoundSchema),
        503: jsonResponse("With strict=1: something needs attention at error severity. Same body.", orgDiagnosticsSchema),
      },
      ...{ "x-mcp": false },
    }),
    orgMemberRoute(),
    queryValidator(diagnosticsQuerySchema),
    async (c) => {
      const caller = await diagnosticsCaller(c)
      if (!caller) return c.json({ error: "organization_not_found" }, 404)
      const diagnostics = await readOrgDiagnostics(caller, { refresh: true })
      const { strict } = c.req.valid("query")
      c.header("Cache-Control", "no-store")
      const failing = (strict === "1" || strict === "true") && hasDiagnosticsErrors(diagnostics.attention)
      return c.json(diagnostics, failing ? 503 : 200)
    },
  )

  app.post(
    "/v1/org/diagnostics/check",
    describeRoute({
      tags: ["Diagnostics"],
      summary: "Run the diagnostics checks the caller may run",
      description: "Starts, in the background, every live check the caller's sections allow: provider model listings with organization-held credentials (never a model request or a member's credential), the Slack assistant token, the caller's own Google API check, and installation services for installation administrators. Shares the rate limits of background checks (one per organization, or per member for connectors, every 30 seconds). Answers with the current diagnostics; poll GET /v1/org/diagnostics until `checking` is false.",
      responses: {
        202: jsonResponse("Checks started, already running, or nothing to check.", orgDiagnosticsSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("No active organization.", notFoundSchema),
        429: jsonResponse("Every requested check ran recently; Retry-After says when another may start. Same body.", orgDiagnosticsSchema),
      },
      ...{ "x-mcp": false },
    }),
    orgMemberRoute(),
    async (c) => {
      const caller = await diagnosticsCaller(c)
      if (!caller) return c.json({ error: "organization_not_found" }, 404)
      const { diagnostics, retryAfter } = await checkOrgDiagnostics(caller)
      c.header("Cache-Control", "no-store")
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json(diagnostics, 429)
      }
      return c.json(diagnostics, 202)
    },
  )

  app.post(
    "/v1/diagnostics/desktop-startup",
    describeRoute({
      tags: ["Diagnostics"],
      summary: "Report one desktop app launch",
      description: "Sent by the signed-in desktop app once per launch (a failed launch may be sent on the next one). Step timings and a fixed failure code only: no hostnames, error text, paths or device identifiers. Attributed to the caller's active organization and membership. Idempotent per attemptId; launches more than 7 days old or more than 5 minutes in the future are ignored.",
      responses: {
        204: { description: "Recorded, already recorded, or ignored." },
        400: jsonResponse("The report was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("No active organization.", notFoundSchema),
        429: jsonResponse("Too many reports from this member; Retry-After says when to send again.", rateLimitedSchema),
      },
      ...{ "x-mcp": false },
    }),
    orgMemberRoute(),
    jsonValidator(desktopStartupReportSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const report = c.req.valid("json")
      const retryAfter = await checkRateLimit(`diagnostics:desktop-startup:${payload.currentMember.id}`, DESKTOP_STARTUP_RATE_LIMIT, DESKTOP_STARTUP_RATE_WINDOW_MS, Date.now())
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited" as const }, 429)
      }
      await recordDesktopStartup({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id, report })
      return c.body(null, 204)
    },
  )
}
