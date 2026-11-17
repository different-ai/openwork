import { createHash, timingSafeEqual } from "node:crypto"
import { processTimingReportSchema } from "@openwork/types/den/diagnostics"
import type { Env, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { recordProcessTiming } from "../diagnostics/process-timing.js"
import { env } from "../env.js"
import { jsonValidator, tokenRoute } from "../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../openapi.js"
import { requestClientIpKey } from "../request-client-ip.js"
import { checkRateLimit } from "../utils/rate-limit.js"

function matchesKey(authorization: string | undefined, key: string) {
  const digest = (value: string) => new Uint8Array(createHash("sha256").update(value).digest())
  return timingSafeEqual(digest(authorization ?? ""), digest(`Bearer ${key}`))
}

export function registerProcessTimingRoutes<T extends Env>(app: Hono<T>) {
  app.post("/v1/diagnostics/process-timing", describeRoute({
    tags: ["Diagnostics"],
    security: [],
    summary: "Report development process timing",
    description: "Shared ingest bearer key, independent of organization sessions. Idempotent by runId. Retained for 90 days. Disabled until PROCESS_TIMING_INGEST_KEY is configured.",
    ...{ "x-mcp": false },
    responses: {
      202: jsonResponse("Report accepted, including repeats.", z.strictObject({ accepted: z.literal(true) })),
      400: jsonResponse("Invalid report.", invalidRequestSchema),
      401: jsonResponse("Ingest key required.", unauthorizedSchema),
      404: jsonResponse("Reporting is off.", notFoundSchema),
      413: jsonResponse("Report too large.", z.object({ error: z.literal("body_too_large") })),
      429: jsonResponse("Too many reports.", z.object({ error: z.literal("rate_limited") })),
    },
  }), tokenRoute, async (c, next) => {
    c.header("Cache-Control", "no-store")
    const key = env.processTimingIngestKey
    if (!key) return c.json({ error: "not_found" }, 404)
    const retryAfter = await checkRateLimit(`diagnostics:process-timing:${requestClientIpKey(c.req.raw.headers)}`, 120, 60_000, Date.now())
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter))
      return c.json({ error: "rate_limited" }, 429)
    }
    if (!matchesKey(c.req.header("Authorization"), key)) return c.json({ error: "unauthorized" }, 401)
    await next()
  }, bodyLimit({ maxSize: 32_768, onError: (c) => c.json({ error: "body_too_large" }, 413) }), jsonValidator(processTimingReportSchema), async (c) => {
    await recordProcessTiming(c.req.valid("json"))
    return c.json({ accepted: true }, 202)
  })
}
