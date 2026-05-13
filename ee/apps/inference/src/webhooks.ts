import { and, eq, sql } from "drizzle-orm"
import type { Hono } from "hono"
import { InferenceUsageLedgerBucketChargeTable, InferenceUsageLedgerEntryTable, InferenceOrgUsageBucketTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { constantTimeEquals } from "./keys.js"

type JsonRecord = Record<string, unknown>

type ParsedSpan = {
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string | null
  openworkRequestId: string
  externalEventId: string | null
  costAmount: number
  occurredAt: Date
  bucketIds: Record<string, DenTypeId<"inferenceOrgUsageBucket">>
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

function costToCredits(value: unknown) {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null
  return Math.max(1, Math.round(numberValue * env.creditsPerDollar))
}

function timeFromSpan(span: JsonRecord) {
  const raw = stringAttr(span, ["endTimeUnixNano", "startTimeUnixNano", "timeUnixNano"])
  if (!raw) return new Date()
  const ms = Number(BigInt(raw) / 1_000_000n)
  return Number.isFinite(ms) ? new Date(ms) : new Date()
}

function parseSpan(span: JsonRecord, resourceAttrs: JsonRecord, scopeAttrs: JsonRecord): ParsedSpan | null {
  const attrs = { ...resourceAttrs, ...scopeAttrs, ...attributesToRecord(span.attributes) }
  const organizationId = stringAttr(attrs, ["trace.metadata.organization_id", "trace.organization_id", "metadata.organization_id", "organization_id"])
  const orgMembershipId = stringAttr(attrs, ["trace.metadata.org_membership_id", "trace.org_membership_id", "metadata.org_membership_id", "org_membership_id"])
  const openworkRequestId = stringAttr(attrs, ["trace.metadata.openwork_request_id", "trace.openwork_request_id", "metadata.openwork_request_id", "openwork_request_id", "trace_id"])
    ?? (typeof span.traceId === "string" ? span.traceId : null)
  const cost = costToCredits(
    attrs["gen_ai.usage.cost"] ?? attrs["openrouter.cost"] ?? attrs.cost ?? attrs["cost_usd"] ?? attrs["usage.cost"],
  )
  if (!organizationId || !orgMembershipId || !openworkRequestId || cost === null) {
    return null
  }

  const bucketIds: Record<string, DenTypeId<"inferenceOrgUsageBucket">> = {}
  for (const [key, value] of Object.entries(attrs)) {
    const match = /^trace\.metadata\.bucket_(.+)_id$|^trace\.bucket_(.+)_id$|^metadata\.bucket_(.+)_id$|^bucket_(.+)_id$/.exec(key)
    const windowType = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4]
    if (windowType && typeof value === "string") {
      try {
        bucketIds[windowType] = normalizeDenTypeId("inferenceOrgUsageBucket", value)
      } catch {
        continue
      }
    }
  }

  return {
    organizationId,
    orgMembershipId,
    inferenceKeyId: stringAttr(attrs, ["trace.metadata.inference_key_id", "trace.inference_key_id", "metadata.inference_key_id", "inference_key_id"]),
    openworkRequestId,
    externalEventId: stringAttr(attrs, ["event_id", "id", "span_id"]) ?? (typeof span.spanId === "string" ? span.spanId : null),
    costAmount: cost,
    occurredAt: timeFromSpan(span),
    bucketIds,
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

function logWebhookDiagnostics(request: Request, outcome: string) {
  const auth = request.headers.get("authorization")
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  const signature = request.headers.get("x-webhook-signature")?.trim() ?? null
  console.log("[openrouter-webhook] diagnostics", {
    outcome,
    webhookSecretPresent: Boolean(env.webhookSecret),
    webhookSecretLength: env.webhookSecret?.length ?? 0,
    authorizationPresent: Boolean(auth),
    authorizationIsBearer: Boolean(bearer),
    bearerLength: bearer?.length ?? 0,
    xWebhookSignaturePresent: Boolean(signature),
    xWebhookSignatureLength: signature?.length ?? 0,
    contentType: request.headers.get("content-type"),
    userAgent: request.headers.get("user-agent"),
  })
}

async function ingestSpan(span: ParsedSpan) {
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
      organization_id: normalizeDenTypeId("organization", span.organizationId),
      org_membership_id: normalizeDenTypeId("member", span.orgMembershipId),
      inference_key_id: span.inferenceKeyId ? normalizeDenTypeId("inferenceKey", span.inferenceKeyId) : null,
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
    for (const bucketId of Object.values(span.bucketIds)) {
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
        used_amount: sql`${InferenceOrgUsageBucketTable.used_amount} + ${span.costAmount}`,
      }).where(eq(InferenceOrgUsageBucketTable.id, bucketId))
    }
  })
}

export function registerWebhookRoutes(app: Hono) {
  app.post("/webhooks/openrouter", async (c) => {
    if (c.req.header("x-test-connection")?.toLowerCase() === "true") {
      logWebhookDiagnostics(c.req.raw, "test_connection")
      return c.body(null, 204)
    }
    if (!env.webhookSecret) {
      logWebhookDiagnostics(c.req.raw, "webhook_disabled")
      return c.json({ error: "webhook_disabled" }, 503)
    }
    if (!isAuthorized(c.req.raw)) {
      logWebhookDiagnostics(c.req.raw, "unauthorized")
      return c.json({ error: "unauthorized" }, 401)
    }
    logWebhookDiagnostics(c.req.raw, "authorized")

    const body = await c.req.json().catch(() => null)
    console.log("[openrouter-webhook] received payload", JSON.stringify(body, null, 2))
    const spans = parseOtlpSpans(body)
    let ingested = 0
    let skipped = 0
    for (const span of spans) {
      try {
        await ingestSpan(span)
        ingested += 1
      } catch (error) {
        skipped += 1
        console.warn("failed to ingest OpenRouter usage span", error)
      }
    }
    return c.json({ ok: true, ingested, skipped })
  })
}
