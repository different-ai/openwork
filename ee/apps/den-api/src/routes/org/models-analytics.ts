import { and, desc, eq, gte, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { ModelsAnalyticsEventTable as Event, ModelsAnalyticsSettingsTable as Settings } from "@openwork-ee/den-db/schema"
import {
  appendModelsAnalyticsEvents, readModelsAnalyticsSettings, modelsAnalyticsActivitySchema,
  modelsAnalyticsChoiceSchema, modelsAnalyticsQuerySchema, modelsAnalyticsRecordSchema,
  modelsAnalyticsSettingsSchema, modelsConsumptionSchema, modelsTaskBatchSchema,
} from "@openwork-ee/telemetry"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { jsonValidator, orgMemberRoute, orgRoleRoute, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus, type OrgRouteVariables } from "./shared.js"

export function registerModelsAnalyticsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/inference/analytics/settings", describeRoute({
    tags: ["Inference"], summary: "Read the OpenWork Models task analytics choice",
    responses: { 200: jsonResponse("Task analytics settings", modelsAnalyticsSettingsSchema) },
  }), orgMemberRoute(), async (c) => {
    const context = c.get("organizationContext")
    return c.json(await readModelsAnalyticsSettings(db, context.organization.id))
  })

  app.patch("/v1/inference/analytics/settings", describeRoute({
    tags: ["Inference"], summary: "Choose whether to collect task analytics included with OpenWork Models",
    responses: { 200: jsonResponse("Updated task analytics choice", modelsAnalyticsSettingsSchema) },
  }), orgRoleRoute(["admin"]), jsonValidator(modelsAnalyticsChoiceSchema), async (c) => {
    const permission = ensureOrganizationAdmin(c, "Only workspace admins can change task analytics.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    const context = c.get("organizationContext")
    const orgId = context.organization.id
    const choice = c.req.valid("json")
    const settings = await readModelsAnalyticsSettings(db, orgId)
    if (choice.enabled && (!settings.available || !settings.subscribed || !settings.modelsEnabled)) {
      return c.json({ error: "models_analytics_unavailable", message: "Task analytics requires access to this feature and an active OpenWork Models subscription." }, 403)
    }
    // Repeating the same choice must not move the collection cutoff forward.
    const consentedAt = choice.enabled && settings.enabled && settings.consentedAt ? new Date(settings.consentedAt) : new Date()
    const values = {
      enabled: choice.enabled, consented_at: consentedAt,
      consented_by: context.currentMember.id, consent_version: 1,
      ...(!choice.enabled ? { export_enabled: false } : {}),
    }
    await db.insert(Settings).values({ org_id: orgId, ...values }).onDuplicateKeyUpdate({ set: values })
    return c.json(await readModelsAnalyticsSettings(db, orgId))
  })

  app.post("/v1/inference/analytics/events", orgMemberRoute(), jsonValidator(modelsTaskBatchSchema), async (c) => {
    const context = c.get("organizationContext")
    const orgId = context.organization.id
    const memberId = context.currentMember.id
    const settings = await readModelsAnalyticsSettings(db, orgId)
    if (!settings.enabled) return c.body(null, 204)
    const { events } = c.req.valid("json")
    // Runtime metadata is accepted only for this member's actual Models calls.
    // A client cannot attach events to another member's task or a BYOK call.
    const calls = await db.select({ sessionId: Event.session_id, taskId: Event.task_id }).from(Event).where(and(
      eq(Event.org_id, orgId), eq(Event.member_id, memberId), eq(Event.source, "inference"),
      inArray(Event.task_id, events.map((event) => event.taskId)),
    ))
    const matched = events.filter((event) => calls.some((call) => call.taskId === event.taskId && call.sessionId === event.sessionId))
    await appendModelsAnalyticsEvents(db, { orgId, memberId, source: "app", events: matched })
    return c.json({ acceptedIds: matched.map((event) => event.id) }, 202)
  })

  app.get("/v1/inference/analytics/activity", describeRoute({
    tags: ["Inference"], summary: "Read task activity collected after the analytics choice",
    responses: { 200: jsonResponse("Task activity", modelsAnalyticsActivitySchema) },
  }), orgRoleRoute(["admin"]), queryValidator(modelsAnalyticsQuerySchema), async (c) => {
    const orgId = c.get("organizationContext").organization.id
    if (!(await readModelsAnalyticsSettings(db, orgId)).enabled) return c.json({ error: "models_analytics_unavailable" }, 403)
    const query = c.req.valid("query")
    const conditions = [eq(Event.org_id, orgId), gte(Event.timestamp, new Date(Date.now() - query.days * 86_400_000))]
    if (query.memberId) conditions.push(sql`${Event.member_id} = ${query.memberId}`)
    if (query.taskId) conditions.push(eq(Event.task_id, query.taskId))
    if (query.sessionId) conditions.push(eq(Event.session_id, query.sessionId))
    if (query.before && query.beforeId) conditions.push(sql`(${Event.timestamp}, ${Event.id}) < (${new Date(query.before)}, ${query.beforeId})`)
    const rows = await db.select().from(Event).where(and(...conditions)).orderBy(desc(Event.timestamp), desc(Event.id)).limit(201)
    const page = rows.slice(0, 200)
    const last = page.at(-1)
    return c.json({
      events: page.map((row) => modelsAnalyticsRecordSchema.parse({ ...row.payload, memberId: row.member_id, source: row.source })),
      next: rows.length > 200 && last ? { before: last.timestamp.toISOString(), beforeId: last.id } : null,
    })
  })

  app.get("/v1/inference/analytics/consumption", describeRoute({
    tags: ["Inference"], summary: "Read provider-reported consumption for OpenWork Models",
    responses: { 200: jsonResponse("Model consumption", modelsConsumptionSchema) },
  }), orgRoleRoute(["admin"]), queryValidator(modelsAnalyticsQuerySchema), async (c) => {
    const orgId = c.get("organizationContext").organization.id
    if (!(await readModelsAnalyticsSettings(db, orgId)).enabled) return c.json({ error: "models_analytics_unavailable" }, 403)
    const query = c.req.valid("query")
    const conditions = [eq(Event.org_id, orgId), eq(Event.type, "model.call"), eq(Event.source, "inference"), gte(Event.timestamp, new Date(Date.now() - query.days * 86_400_000))]
    if (query.memberId) conditions.push(sql`${Event.member_id} = ${query.memberId}`)
    const day = sql<string>`date_format(${Event.timestamp}, '%Y-%m-%d')`
    const rows = await db.select({
      model: Event.model, provider: Event.provider, memberId: Event.member_id, day,
      calls: sql<number>`count(*)`,
      failedCalls: sql<number>`sum(json_unquote(json_extract(${Event.payload}, '$.status')) = 'failed')`,
      incompleteCalls: sql<number>`sum(${Event.usage_complete} is null or ${Event.usage_complete} = false)`,
      inputTokens: sql<number | null>`sum(${Event.input_tokens})`, outputTokens: sql<number | null>`sum(${Event.output_tokens})`,
      cacheReadTokens: sql<number | null>`sum(${Event.cache_read_tokens})`, costUsd: sql<number | null>`sum(${Event.cost_usd})`,
    }).from(Event).where(and(...conditions)).groupBy(Event.model, Event.provider, Event.member_id, day).orderBy(desc(day)).limit(10_001)
    if (rows.length > 10_000) return c.json({ error: "narrow_date_range", message: "Choose a shorter date range to see consumption." }, 400)
    return c.json({ groups: rows.map((row) => ({ ...row, calls: Number(row.calls), failedCalls: Number(row.failedCalls), incompleteCalls: Number(row.incompleteCalls),
      inputTokens: row.inputTokens === null ? null : Number(row.inputTokens), outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
      cacheReadTokens: row.cacheReadTokens === null ? null : Number(row.cacheReadTokens), costUsd: row.costUsd === null ? null : Number(row.costUsd),
    })) })
  })
}
