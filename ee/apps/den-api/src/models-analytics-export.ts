import { createHash } from "node:crypto"
import { and, asc, eq, gte, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ModelsAnalyticsSettingsTable as Settings, ModelsAnalyticsEventTable as Event } from "@openwork-ee/den-db/schema"
import { modelsAnalyticsEventSchema, readModelsAnalyticsSettings } from "@openwork-ee/telemetry"
import type { Hono } from "hono"
import { z } from "zod"
import { db } from "./db.js"
import { postModelsAnalytics } from "./models-analytics-egress.js"
import { jsonValidator, orgRoleRoute } from "./middleware/index.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus, type OrgRouteVariables } from "./routes/org/shared.js"

const configSchema = z.object({
  host: z.url().max(512).refine((value) => {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
  }, "Use the HTTPS address of your Langfuse instance, without a path"),
  publicKey: z.string().trim().min(1).max(512),
  secretKey: z.string().trim().min(1).max(512),
}).strict()

async function send(config: z.infer<typeof configSchema>, spans: unknown[]) {
  const response = await postModelsAnalytics(new URL("/api/public/otel/v1/traces", config.host), {
    "Content-Type": "application/json", "x-langfuse-ingestion-version": "4",
    Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
  }, JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "openwork-models" } }] }, scopeSpans: [{ scope: { name: "openwork.task-analytics", version: "1" }, spans }] }] }))
  const ack = z.object({ partialSuccess: z.object({ rejectedSpans: z.union([z.number(), z.string()]).optional() }).optional() }).safeParse(response)
  if (!ack.success || Number(ack.data.partialSuccess?.rejectedSpans ?? 0) > 0) throw new Error("langfuse_rejected_spans")
}

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
export function modelsAnalyticsSpan(row: typeof Event.$inferSelect) {
  const event = modelsAnalyticsEventSchema.parse(row.payload)
  const traceId = hash([row.org_id, row.member_id, event.sessionId, event.taskId]).slice(0, 32)
  const terminal = event.type.startsWith("task.") && event.type !== "task.started"
  const attributes: Record<string, string | number | boolean> = {
    "langfuse.user.id": row.member_id, "langfuse.session.id": event.sessionId,
    "langfuse.trace.name": "OpenWork task", "langfuse.trace.metadata.organization_id": row.org_id,
    "langfuse.trace.metadata.task_id": event.taskId,
    "langfuse.observation.type": event.type === "model.call" ? "generation" : event.type === "tool.executed" ? "tool" : "span",
    "langfuse.trace.metadata.event_type": event.type,
  }
  if (event.model) attributes["gen_ai.request.model"] = event.model
  if (event.provider) attributes["gen_ai.provider.name"] = event.provider
  if (event.tool) attributes["langfuse.trace.metadata.tool"] = event.tool
  if (event.skill) attributes["langfuse.trace.metadata.skill"] = event.skill
  if (event.skillVersion) attributes["langfuse.version"] = event.skillVersion
  if (event.mcp) attributes["langfuse.trace.metadata.mcp"] = event.mcp
  if (event.usageComplete !== undefined) attributes["langfuse.trace.metadata.usage_complete"] = event.usageComplete
  attributes["langfuse.observation.usage_details"] = JSON.stringify({ input: event.inputTokens, output: event.outputTokens, cache_read_input_tokens: event.cacheReadTokens, cache_creation_input_tokens: event.cacheWriteTokens })
  if (event.costUsd !== undefined) attributes["langfuse.observation.cost_details"] = JSON.stringify({ total: event.costUsd })
  for (const [key, value] of Object.entries(event.metadata ?? {})) attributes[`langfuse.trace.metadata.custom.${key}`] = value
  const timestamp = Date.parse(event.timestamp)
  const start = event.type === "model.call" ? timestamp : Math.max(0, timestamp - (event.durationMs ?? 0))
  const end = event.type === "model.call" ? timestamp + (event.durationMs ?? 0) : timestamp
  return {
    traceId, spanId: terminal ? hash([traceId, "task"]).slice(0, 16) : row.id.slice(0, 16),
    ...(!terminal ? { parentSpanId: hash([traceId, "task"]).slice(0, 16) } : {}),
    name: terminal ? "OpenWork task" : event.model ?? event.skill ?? event.tool ?? event.type,
    kind: 1, startTimeUnixNano: String(BigInt(start) * 1_000_000n), endTimeUnixNano: String(BigInt(end) * 1_000_000n),
    status: { code: event.status === "failed" ? 2 : 0 },
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } })),
  }
}

export function registerModelsAnalyticsExportRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  for (const action of ["test", "connect"]) {
    app.post(`/v1/inference/analytics/langfuse/${action}`, orgRoleRoute(["admin"]), jsonValidator(configSchema), async (c) => {
      const permission = ensureOrganizationAdmin(c, "Only workspace admins can configure analytics exports.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const orgId = c.get("organizationContext").organization.id
      if (!(await readModelsAnalyticsSettings(db, orgId)).enabled) return c.json({ error: "models_analytics_unavailable" }, 403)
      const config = c.req.valid("json")
      try { await send(config, []) } catch { return c.json({ error: "langfuse_connection_failed", message: "Could not connect. Check the Langfuse address and project keys." }, 400) }
      if (action === "connect") {
        // Recheck consent after the network request. No exports of earlier data.
        if (!(await readModelsAnalyticsSettings(db, orgId)).enabled) return c.json({ error: "models_analytics_unavailable" }, 403)
        const connected = await db.transaction(async (tx) => {
          const [current] = await tx.select({ enabled: Settings.enabled }).from(Settings).where(eq(Settings.org_id, orgId)).limit(1).for("update")
          if (!current?.enabled) return false
          await tx.update(Settings).set({ langfuse_host: new URL(config.host).origin,
            langfuse_public_key: config.publicKey, langfuse_secret_key: config.secretKey,
            export_enabled: true, export_enabled_at: new Date(),
          }).where(eq(Settings.org_id, orgId))
          return true
        })
        if (!connected) return c.json({ error: "models_analytics_unavailable" }, 403)
      }
      return c.json({ ok: true })
    })
  }
  app.delete("/v1/inference/analytics/langfuse", orgRoleRoute(["admin"]), async (c) => {
    const permission = ensureOrganizationAdmin(c, "Only workspace admins can disconnect analytics exports.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    await db.update(Settings).set({ export_enabled: false, langfuse_public_key: null, langfuse_secret_key: null, langfuse_host: null, export_enabled_at: null })
      .where(eq(Settings.org_id, c.get("organizationContext").organization.id))
    return c.json({ ok: true })
  })
}

// The event store is the outbox. Stable span IDs make retries idempotent;
// failures never run on the chat request path. Recheck access on every batch.
export function startModelsAnalyticsExportLoop() {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const destinations = await db.select({ orgId: Settings.org_id }).from(Settings).where(and(eq(Settings.enabled, true), eq(Settings.export_enabled, true)))
      for (const destination of destinations) {
        try {
          // Opt-out, disconnect and deletion acquire this same row lock. They
          // cannot return while an authorized batch is still being transmitted.
          await db.transaction(async (tx) => {
            const [config] = await tx.select().from(Settings).where(eq(Settings.org_id, destination.orgId)).limit(1).for("update")
            if (!config?.enabled || !config.export_enabled) return
            if (!config.langfuse_host || !config.langfuse_public_key || !config.langfuse_secret_key || !config.export_enabled_at) return
            const access = await readModelsAnalyticsSettings(db, config.org_id)
            if (!access.enabled || !access.exportEnabled) return
            const rows = await tx.select().from(Event).where(and(eq(Event.org_id, config.org_id), isNull(Event.exported_at), gte(Event.timestamp, config.export_enabled_at)))
              .orderBy(asc(Event.created_at)).limit(100)
            if (!rows.length) return
            await send({ host: config.langfuse_host, publicKey: config.langfuse_public_key, secretKey: config.langfuse_secret_key }, rows.filter((row) => row.type !== "task.started").map(modelsAnalyticsSpan))
            await tx.update(Event).set({ exported_at: new Date() }).where(inArray(Event.id, rows.map((row) => row.id)))
          })
        } catch { /* Keep the batch for retry; no credentials or payloads in logs. */ }
      }
    } catch { /* A disabled deployment or unavailable store must not affect chat. */ }
    finally { running = false }
  }, 30_000)
  timer.unref()
  return () => clearInterval(timer)
}
