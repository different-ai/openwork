import { and, eq, sql } from "drizzle-orm"
import type { Hono } from "hono"
import { InferenceKeyTable, InferenceUsageLedgerBucketChargeTable, InferenceUsageLedgerEntryTable, InferenceOrgUsageBucketTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { db } from "./db.js"
import { env } from "./env.js"
import { constantTimeEquals } from "./keys.js"
import { ensureUsableBuckets } from "./limits.js"
import { resolveModelByUpstreamModel } from "./model-catalog.js"

type JsonRecord = Record<string, unknown>

type ParsedSpan = {
  orgMembershipId: string
  inferenceKeyId: string
  openworkRequestId: string
  externalEventId: string | null
  costAmount: number
  occurredAt: Date
  upstreamModel: string
  inputCost: number
  outputCost: number
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function values(value: unknown) {
  return Array.isArray(value) ? value : []
}

function attributeValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  if ("stringValue" in value) return value.stringValue
  if ("intValue" in value) return value.intValue
  if ("doubleValue" in value) return value.doubleValue
  if ("boolValue" in value) return value.boolValue
  return value
}

function attributesToRecord(attributes: unknown) {
  const out: JsonRecord = {}
  for (const attr of values(attributes)) {
    if (isRecord(attr) && typeof attr.key === "string") {
      out[attr.key] = attributeValue(attr.value)
    }
  }
  return out
}

function stringAttr(attrs: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = attrs[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return null
}

function numberAttr(attrs: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = attrs[key]
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
    if (Number.isFinite(numberValue)) return numberValue
  }
  return null
}

function usageUnitsForModel(input: { upstreamModel: string; inputCost: number; outputCost: number }) {
  const model = resolveModelByUpstreamModel(input.upstreamModel)
  if (!model) return null
  return Math.max(1, Math.ceil((input.inputCost + input.outputCost) * INFERENCE_USAGE_CONVERSION_FACTOR * model.usageFactor))
}

function logWebhookError(message: string, details?: Record<string, unknown>) {
  console.error(`[openrouter-webhook] ${message}`, details ?? {})
}

function timeFromSpan(span: JsonRecord) {
  const raw = stringAttr(span, ["endTimeUnixNano", "startTimeUnixNano", "timeUnixNano"])
  if (!raw) return new Date()
  const ms = Number(BigInt(raw) / 1_000_000n)
  return Number.isFinite(ms) ? new Date(ms) : new Date()
}

function parseSpan(span: JsonRecord, resourceAttrs: JsonRecord, scopeAttrs: JsonRecord): ParsedSpan | null {
  const attrs = { ...resourceAttrs, ...scopeAttrs, ...attributesToRecord(span.attributes) }
  const orgMembershipId = stringAttr(attrs, ["trace.metadata.org_membership_id", "trace.org_membership_id", "metadata.org_membership_id", "org_membership_id"])
  const inferenceKeyId = stringAttr(attrs, ["trace.metadata.inference_key_id", "trace.inference_key_id", "metadata.inference_key_id", "inference_key_id"])
  const openworkRequestId = stringAttr(attrs, ["trace.metadata.openwork_request_id", "trace.openwork_request_id", "metadata.openwork_request_id", "openwork_request_id", "trace_id"])
    ?? (typeof span.traceId === "string" ? span.traceId : null)
  const upstreamModel = stringAttr(attrs, ["gen_ai.request.model", "gen_ai.response.model"])
  const inputCost = numberAttr(attrs, ["gen_ai.usage.input_cost"])
  const outputCost = numberAttr(attrs, ["gen_ai.usage.output_cost"])
  if (!orgMembershipId || !inferenceKeyId || !openworkRequestId || !upstreamModel || inputCost === null || outputCost === null) {
    return null
  }

  const costAmount = usageUnitsForModel({ upstreamModel, inputCost, outputCost })
  if (costAmount === null) {
    logWebhookError("skipped span for unknown priced model", { upstreamModel })
    return null
  }

  return {
    orgMembershipId,
    inferenceKeyId,
    openworkRequestId,
    externalEventId: stringAttr(attrs, ["event_id", "id", "span_id"]) ?? (typeof span.spanId === "string" ? span.spanId : null),
    costAmount,
    occurredAt: timeFromSpan(span),
    upstreamModel,
    inputCost,
    outputCost,
  }
}

function parseOtlpSpans(body: unknown) {
  const spans: ParsedSpan[] = []
  if (!isRecord(body)) return spans
  for (const resourceSpan of values(body.resourceSpans)) {
    if (!isRecord(resourceSpan)) continue
    const resourceAttrs = attributesToRecord(isRecord(resourceSpan.resource) ? resourceSpan.resource.attributes : undefined)
    for (const scopeSpan of values(resourceSpan.scopeSpans)) {
      if (!isRecord(scopeSpan)) continue
      const scopeAttrs = attributesToRecord(isRecord(scopeSpan.scope) ? scopeSpan.scope.attributes : undefined)
      for (const span of values(scopeSpan.spans)) {
        if (!isRecord(span)) continue
        const parsed = parseSpan(span, resourceAttrs, scopeAttrs)
        if (parsed) spans.push(parsed)
      }
    }
  }
  return spans
}

function isAuthorized(request: Request) {
  if (!env.webhookSecret) return false
  const auth = request.headers.get("authorization")
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  const signature = request.headers.get("x-webhook-signature")?.trim() ?? null
  return [bearer, signature].some((value) => value !== null && constantTimeEquals(value, env.webhookSecret!))
}

async function ingestSpan(span: ParsedSpan) {
  const [inferenceKey] = await db.select().from(InferenceKeyTable)
    .where(eq(InferenceKeyTable.id, normalizeDenTypeId("inferenceKey", span.inferenceKeyId)))
    .limit(1)
  if (!inferenceKey || inferenceKey.status !== "active") {
    logWebhookError("skipped span for missing or inactive inference key", { inferenceKeyId: span.inferenceKeyId })
    return
  }
  if (inferenceKey.org_membership_id !== normalizeDenTypeId("member", span.orgMembershipId)) {
    logWebhookError("skipped span for mismatched org membership", {
      inferenceKeyId: span.inferenceKeyId,
      spanOrgMembershipId: span.orgMembershipId,
      keyOrgMembershipId: inferenceKey.org_membership_id,
    })
    return
  }

  const limits = await ensureUsableBuckets(inferenceKey.organization_id, span.occurredAt)
  if (!limits.ok) {
    logWebhookError("settling usage after limit was exceeded", {
      inferenceKeyId: span.inferenceKeyId,
      limitedBy: limits.limitedBy,
    })
  }

  if (span.externalEventId) {
    const [event] = await db.select({ id: InferenceUsageLedgerEntryTable.id }).from(InferenceUsageLedgerEntryTable)
      .where(eq(InferenceUsageLedgerEntryTable.external_event_id, span.externalEventId))
      .limit(1)
    if (event) return
  }

  const [existing] = await db.select({ id: InferenceUsageLedgerEntryTable.id }).from(InferenceUsageLedgerEntryTable)
    .where(and(eq(InferenceUsageLedgerEntryTable.external_job_id, span.openworkRequestId), eq(InferenceUsageLedgerEntryTable.event_type, "openrouter_usage"))).limit(1)
  const entry = existing ?? await (async () => {
    const entryId = createDenTypeId("inferenceUsageLedgerEntry")
    await db.insert(InferenceUsageLedgerEntryTable).values({
      id: entryId,
      organization_id: inferenceKey.organization_id,
      org_membership_id: inferenceKey.org_membership_id,
      inference_key_id: inferenceKey.id,
      external_job_id: span.openworkRequestId,
      external_event_id: span.externalEventId,
      cost_amount: span.costAmount,
      event_type: "openrouter_usage",
      occurred_at: span.occurredAt,
    })
    return { id: entryId }
  })()
  if (!entry) return

  await db.transaction(async (tx) => {
    const bucketLimits = limits.bucketLimits as Record<string, number | undefined>
    for (const [windowType, bucketId] of Object.entries(limits.bucketIds)) {
      if (!bucketId) continue
      const limitAmount = bucketLimits[windowType]
      if (limitAmount === undefined) continue
      const [charge] = await tx.select({ id: InferenceUsageLedgerBucketChargeTable.id })
        .from(InferenceUsageLedgerBucketChargeTable)
        .where(and(
          eq(InferenceUsageLedgerBucketChargeTable.ledger_entry_id, entry.id),
          eq(InferenceUsageLedgerBucketChargeTable.bucket_id, bucketId),
        ))
        .limit(1)
      if (charge) {
        continue
      }

      await tx.insert(InferenceUsageLedgerBucketChargeTable).values({
        id: createDenTypeId("inferenceUsageLedgerBucketCharge"),
        ledger_entry_id: entry.id,
        bucket_id: bucketId,
        amount: span.costAmount,
      })
      await tx.update(InferenceOrgUsageBucketTable).set({
        limit_amount: limitAmount,
        used_amount: sql`${InferenceOrgUsageBucketTable.used_amount} + ${span.costAmount}`,
      }).where(eq(InferenceOrgUsageBucketTable.id, bucketId))
    }
  })
}

export function registerWebhookRoutes(app: Hono) {
  app.post("/webhooks/openrouter", async (c) => {
    if (c.req.header("x-test-connection")?.toLowerCase() === "true") {
      return c.body(null, 204)
    }
    if (!env.webhookSecret) {
      logWebhookError("webhook secret is not configured")
      return c.json({ error: "webhook_disabled" }, 503)
    }
    if (!isAuthorized(c.req.raw)) {
      logWebhookError("unauthorized webhook request", {
        hasAuthorization: Boolean(c.req.header("authorization")),
        hasSignature: Boolean(c.req.header("x-webhook-signature")),
      })
      return c.json({ error: "unauthorized" }, 401)
    }

    const body = await c.req.json().catch((error) => {
      logWebhookError("failed to parse webhook JSON", { error: error instanceof Error ? error.message : String(error) })
      return null
    })
    const spans = parseOtlpSpans(body)
    let ingested = 0
    let skipped = 0
    for (const span of spans) {
      try {
        await ingestSpan(span)
        ingested += 1
      } catch (error) {
        skipped += 1
        logWebhookError("failed to ingest OpenRouter usage span", { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return c.json({ ok: true, ingested, skipped })
  })
}
