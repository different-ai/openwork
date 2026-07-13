import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import type { Hono } from "hono"
import { InferenceKeyTable, InferenceUsageLedgerBucketChargeTable, InferenceUsageLedgerEntryTable, InferenceOrgUsageBucketTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import * as Sentry from "@sentry/node"
import { db } from "./db.js"
import { env } from "./env.js"
import { constantTimeEquals } from "./keys.js"
import { ensureUsableBuckets as ensureUsageBuckets } from "./limits.js"
import type { BucketLimitMetadata, BucketMetadata } from "./limits.js"
import { resolveModelByUpstreamModel } from "./model-catalog.js"

type JsonRecord = Record<string, unknown>

type OpenRouterUsageMetadata = {
  requestModel: string | null
  responseModel: string | null
  inputCost: number
  outputCost: number
  totalCost: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  generationId: string | null
  spanId: string | null
  traceId: string | null
  spanName: string | null
  currency: string | null
}

export type OpenRouterUnknownModelUsageReport = {
  reportedModel: string
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string
  openworkRequestId: string
  externalEventId: string | null
  generationId: string | null
  usage: OpenRouterUsageMetadata
}

type OpenRouterUsageWebhookReporter = {
  unknownModel(report: OpenRouterUnknownModelUsageReport): void
}

type ParsedSpan = {
  orgMembershipId: string
  inferenceKeyId: string
  openworkRequestId: string
  externalEventId: string | null
  generationId: string | null
  occurredAt: Date
  reportedModel: string
  requestModel: string | null
  responseModel: string | null
  inputCost: number
  outputCost: number
  usageMetadata: OpenRouterUsageMetadata
}

type WebhookInferenceKey = {
  id: DenTypeId<"inferenceKey">
  status: string
  organization_id: DenTypeId<"organization">
  org_membership_id: DenTypeId<"member">
}

type UsageBucketSettlement = {
  ok: boolean
  bucketIds: BucketMetadata
  bucketLimits: BucketLimitMetadata
  limitedBy?: string
}

type UsageLedgerEntryRef = {
  id: DenTypeId<"inferenceUsageLedgerEntry">
}

type InsertUsageLedgerEntryInput = {
  inferenceKey: WebhookInferenceKey
  span: ParsedSpan
  costAmount: number
}

type ChargeBucketsInput = {
  limits: UsageBucketSettlement
  ledgerEntryId: DenTypeId<"inferenceUsageLedgerEntry">
  costAmount: number
}

type WebhookDependencies = {
  reporter: OpenRouterUsageWebhookReporter
  findInferenceKey(inferenceKeyId: string): Promise<WebhookInferenceKey | null>
  ensureUsableBuckets(organizationId: string, occurredAt: Date): Promise<UsageBucketSettlement>
  findLedgerEntryByExternalEventId(externalEventId: string): Promise<UsageLedgerEntryRef | null>
  findOpenRouterUsageLedgerEntry(openworkRequestId: string): Promise<UsageLedgerEntryRef | null>
  insertOpenRouterUsageLedgerEntry(input: InsertUsageLedgerEntryInput): Promise<UsageLedgerEntryRef>
  chargeBuckets(input: ChargeBucketsInput): Promise<void>
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

function spanString(span: JsonRecord, key: string) {
  const value = span[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
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

function usageMetadataFromSpan(input: {
  span: JsonRecord
  attrs: JsonRecord
  requestModel: string | null
  responseModel: string | null
  inputCost: number
  outputCost: number
  generationId: string | null
}): OpenRouterUsageMetadata {
  return {
    requestModel: input.requestModel,
    responseModel: input.responseModel,
    inputCost: input.inputCost,
    outputCost: input.outputCost,
    totalCost: input.inputCost + input.outputCost,
    inputTokens: numberAttr(input.attrs, ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.usage.prompt_tokens", "prompt_tokens"]),
    outputTokens: numberAttr(input.attrs, ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.usage.completion_tokens", "completion_tokens"]),
    totalTokens: numberAttr(input.attrs, ["gen_ai.usage.total_tokens", "llm.usage.total_tokens", "total_tokens"]),
    generationId: input.generationId,
    spanId: spanString(input.span, "spanId") ?? stringAttr(input.attrs, ["span_id"]),
    traceId: spanString(input.span, "traceId") ?? stringAttr(input.attrs, ["trace_id"]),
    spanName: spanString(input.span, "name"),
    currency: stringAttr(input.attrs, ["gen_ai.usage.currency", "gen_ai.cost.currency"]),
  }
}

function parseSpan(span: JsonRecord, resourceAttrs: JsonRecord, scopeAttrs: JsonRecord): ParsedSpan | null {
  const attrs = { ...resourceAttrs, ...scopeAttrs, ...attributesToRecord(span.attributes) }
  const orgMembershipId = stringAttr(attrs, ["trace.metadata.org_membership_id", "trace.org_membership_id", "metadata.org_membership_id", "org_membership_id"])
  const inferenceKeyId = stringAttr(attrs, ["trace.metadata.inference_key_id", "trace.inference_key_id", "metadata.inference_key_id", "inference_key_id"])
  const openworkRequestId = stringAttr(attrs, ["trace.metadata.openwork_request_id", "trace.openwork_request_id", "metadata.openwork_request_id", "openwork_request_id", "trace_id"])
    ?? (typeof span.traceId === "string" ? span.traceId : null)
  const requestModel = stringAttr(attrs, ["gen_ai.request.model"])
  const responseModel = stringAttr(attrs, ["gen_ai.response.model"])
  const reportedModel = responseModel ?? requestModel
  const inputCost = numberAttr(attrs, ["gen_ai.usage.input_cost"])
  const outputCost = numberAttr(attrs, ["gen_ai.usage.output_cost"])
  if (!orgMembershipId || !inferenceKeyId || !openworkRequestId || !reportedModel || inputCost === null || outputCost === null) {
    return null
  }
  const generationId = stringAttr(attrs, ["gen_ai.response.id", "gen_ai.generation.id", "generation_id", "response_id"])
  const externalEventId = stringAttr(attrs, ["event_id", "id", "span_id"]) ?? generationId ?? spanString(span, "spanId")

  return {
    orgMembershipId,
    inferenceKeyId,
    openworkRequestId,
    externalEventId,
    generationId,
    occurredAt: timeFromSpan(span),
    reportedModel,
    requestModel,
    responseModel,
    inputCost,
    outputCost,
    usageMetadata: usageMetadataFromSpan({ span, attrs, requestModel, responseModel, inputCost, outputCost, generationId }),
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
  const webhookSecret = env.webhookSecret
  const auth = request.headers.get("authorization")
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null
  const signature = request.headers.get("x-webhook-signature")?.trim() ?? null
  return [bearer, signature].some((value) => value !== null && constantTimeEquals(value, webhookSecret))
}

const sentryWebhookReporter: OpenRouterUsageWebhookReporter = {
  unknownModel(report) {
    Sentry.captureMessage("OpenRouter usage webhook could not infer cost for reported model", {
      level: "fatal",
      tags: {
        organization_id: report.organizationId,
        openwork_request_id: report.openworkRequestId,
        external_event_id: report.externalEventId ?? "none",
        reported_model: report.reportedModel,
      },
      contexts: {
        openrouter_usage_webhook: report,
      },
    })
  },
}

const defaultWebhookDependencies: WebhookDependencies = {
  reporter: sentryWebhookReporter,
  async findInferenceKey(inferenceKeyId) {
    const [inferenceKey] = await db.select().from(InferenceKeyTable)
      .where(eq(InferenceKeyTable.id, normalizeDenTypeId("inferenceKey", inferenceKeyId)))
      .limit(1)
    return inferenceKey ?? null
  },
  async ensureUsableBuckets(organizationId, occurredAt) {
    return ensureUsageBuckets(organizationId, occurredAt)
  },
  async findLedgerEntryByExternalEventId(externalEventId) {
    const [event] = await db.select({ id: InferenceUsageLedgerEntryTable.id }).from(InferenceUsageLedgerEntryTable)
      .where(eq(InferenceUsageLedgerEntryTable.external_event_id, externalEventId))
      .limit(1)
    return event ?? null
  },
  async findOpenRouterUsageLedgerEntry(openworkRequestId) {
    const [existing] = await db.select({ id: InferenceUsageLedgerEntryTable.id }).from(InferenceUsageLedgerEntryTable)
      .where(and(eq(InferenceUsageLedgerEntryTable.external_job_id, openworkRequestId), eq(InferenceUsageLedgerEntryTable.event_type, "openrouter_usage"))).limit(1)
    return existing ?? null
  },
  async insertOpenRouterUsageLedgerEntry(input) {
    const entryId = createDenTypeId("inferenceUsageLedgerEntry")
    await db.insert(InferenceUsageLedgerEntryTable).values({
      id: entryId,
      organization_id: input.inferenceKey.organization_id,
      org_membership_id: input.inferenceKey.org_membership_id,
      inference_key_id: input.inferenceKey.id,
      external_job_id: input.span.openworkRequestId,
      external_event_id: input.span.externalEventId,
      cost_amount: input.costAmount,
      event_type: "openrouter_usage",
      occurred_at: input.span.occurredAt,
    })
    return { id: entryId }
  },
  async chargeBuckets(input) {
    await db.transaction(async (tx) => {
      for (const [windowType, bucketId] of Object.entries(input.limits.bucketIds)) {
        if (!bucketId) continue
        const limitAmount = input.limits.bucketLimits[windowType]
        if (limitAmount === undefined) continue
        const [charge] = await tx.select({ id: InferenceUsageLedgerBucketChargeTable.id })
          .from(InferenceUsageLedgerBucketChargeTable)
          .where(and(
            eq(InferenceUsageLedgerBucketChargeTable.ledger_entry_id, input.ledgerEntryId),
            eq(InferenceUsageLedgerBucketChargeTable.bucket_id, bucketId),
          ))
          .limit(1)
        if (charge) {
          continue
        }

        await tx.insert(InferenceUsageLedgerBucketChargeTable).values({
          id: createDenTypeId("inferenceUsageLedgerBucketCharge"),
          ledger_entry_id: input.ledgerEntryId,
          bucket_id: bucketId,
          amount: input.costAmount,
        })
        await tx.update(InferenceOrgUsageBucketTable).set({
          limit_amount: limitAmount,
          used_amount: sql`${InferenceOrgUsageBucketTable.used_amount} + ${input.costAmount}`,
        }).where(eq(InferenceOrgUsageBucketTable.id, bucketId))
      }
    })
  },
}

function reportUnknownPricedModel(input: { span: ParsedSpan; inferenceKey: WebhookInferenceKey; reporter: OpenRouterUsageWebhookReporter }) {
  logWebhookError("skipped span for unknown priced model", {
    reportedModel: input.span.reportedModel,
    organizationId: input.inferenceKey.organization_id,
    openworkRequestId: input.span.openworkRequestId,
    externalEventId: input.span.externalEventId,
  })
  input.reporter.unknownModel({
    reportedModel: input.span.reportedModel,
    organizationId: input.inferenceKey.organization_id,
    orgMembershipId: input.inferenceKey.org_membership_id,
    inferenceKeyId: input.inferenceKey.id,
    openworkRequestId: input.span.openworkRequestId,
    externalEventId: input.span.externalEventId,
    generationId: input.span.generationId,
    usage: input.span.usageMetadata,
  })
}

async function ingestSpan(span: ParsedSpan, dependencies: WebhookDependencies) {
  const inferenceKey = await dependencies.findInferenceKey(span.inferenceKeyId)
  if (!inferenceKey || inferenceKey.status !== "active") {
    logWebhookError("skipped span for missing or inactive inference key", { inferenceKeyId: span.inferenceKeyId })
    return false
  }
  if (inferenceKey.org_membership_id !== normalizeDenTypeId("member", span.orgMembershipId)) {
    logWebhookError("skipped span for mismatched org membership", {
      inferenceKeyId: span.inferenceKeyId,
      spanOrgMembershipId: span.orgMembershipId,
      keyOrgMembershipId: inferenceKey.org_membership_id,
    })
    return false
  }

  const costAmount = usageUnitsForModel({ upstreamModel: span.reportedModel, inputCost: span.inputCost, outputCost: span.outputCost })
  if (costAmount === null) {
    reportUnknownPricedModel({ span, inferenceKey, reporter: dependencies.reporter })
    return false
  }

  const limits = await dependencies.ensureUsableBuckets(inferenceKey.organization_id, span.occurredAt)
  if (!limits.ok) {
    logWebhookError("settling usage after limit was exceeded", {
      inferenceKeyId: span.inferenceKeyId,
      limitedBy: limits.limitedBy,
    })
  }

  if (span.externalEventId) {
    const event = await dependencies.findLedgerEntryByExternalEventId(span.externalEventId)
    if (event) return false
  }

  const existing = await dependencies.findOpenRouterUsageLedgerEntry(span.openworkRequestId)
  const entry = existing ?? await dependencies.insertOpenRouterUsageLedgerEntry({ inferenceKey, span, costAmount })
  await dependencies.chargeBuckets({ limits, ledgerEntryId: entry.id, costAmount })
  return true
}

export function registerWebhookRoutes(app: Hono, dependencies: WebhookDependencies = defaultWebhookDependencies) {
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
        if (await ingestSpan(span, dependencies)) {
          ingested += 1
        } else {
          skipped += 1
        }
      } catch (error) {
        skipped += 1
        logWebhookError("failed to ingest OpenRouter usage span", { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return c.json({ ok: true, ingested, skipped })
  })
}
