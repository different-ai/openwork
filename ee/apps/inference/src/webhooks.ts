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
import { settlementBuckets as ensureUsageBuckets } from "./limits.js"
import type { BucketLimitMetadata, BucketMetadata } from "./limits.js"
import { resolveModelByUpstreamModel } from "./model-catalog.js"

type JsonRecord = Record<string, unknown>

type OpenRouterUsageMetadata = {
  requestModel: string | null
  responseModel: string | null
  inputCost: number | null
  outputCost: number | null
  totalCost: number | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  reasoningTokens: number | null
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
  inputCost: number | null
  outputCost: number | null
  usageMetadata: OpenRouterUsageMetadata
}

type WebhookInferenceKey = {
  id: DenTypeId<"inferenceKey">
  status: string
  revoked_at?: Date | null
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
  organizationId: string
  memberId: string
  inferenceKeyId: string | null
  requestId: string
  costAmount: number
}

type InsertUsageLedgerEntryInput = {
  inferenceKey: WebhookInferenceKey
  span: ParsedSpan
  costAmount: number
  unpriced?: boolean
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
    if (Number.isFinite(numberValue) && numberValue >= 0) return numberValue
  }
  return null
}

function spanString(span: JsonRecord, key: string) {
  const value = span[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function tokenAttr(attrs: JsonRecord, keys: string[]) {
  const value = numberAttr(attrs, keys)
  return value !== null && Number.isSafeInteger(value) && value <= 2_147_483_647 ? value : null
}

function usageUnitsForModel(input: { upstreamModel: string; inputCost: number | null; outputCost: number | null }) {
  const model = resolveModelByUpstreamModel(input.upstreamModel)
  if (!model || input.inputCost === null || input.outputCost === null) return null
  const amount = Math.max(1, Math.ceil((input.inputCost + input.outputCost) * INFERENCE_USAGE_CONVERSION_FACTOR * model.usageFactor))
  return Number.isSafeInteger(amount) ? amount : null
}

function logWebhookError(message: string, details?: Record<string, unknown>) {
  console.error(`[openrouter-webhook] ${message}`, details ?? {})
}

function timeFromSpan(span: JsonRecord, attrs: JsonRecord) {
  const admittedAt = stringAttr(attrs, ["trace.usage_started_at", "trace.metadata.usage_started_at", "metadata.usage_started_at", "usage_started_at"])
  if (admittedAt) {
    const date = new Date(admittedAt)
    if (Number.isFinite(date.getTime())) return date
  }
  const raw = stringAttr(span, ["startTimeUnixNano", "endTimeUnixNano", "timeUnixNano"])
  if (!raw || !/^\d+$/.test(raw)) return null
  const date = new Date(Number(BigInt(raw) / 1_000_000n))
  return Number.isFinite(date.getTime()) ? date : null
}

function usageMetadataFromSpan(input: {
  span: JsonRecord
  attrs: JsonRecord
  requestModel: string | null
  responseModel: string | null
  inputCost: number | null
  outputCost: number | null
  generationId: string | null
}): OpenRouterUsageMetadata {
  return {
    requestModel: input.requestModel,
    responseModel: input.responseModel,
    inputCost: input.inputCost,
    outputCost: input.outputCost,
    totalCost: input.inputCost === null || input.outputCost === null ? null : input.inputCost + input.outputCost,
    inputTokens: tokenAttr(input.attrs, ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.usage.prompt_tokens", "prompt_tokens"]),
    outputTokens: tokenAttr(input.attrs, ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.usage.completion_tokens", "completion_tokens"]),
    totalTokens: tokenAttr(input.attrs, ["gen_ai.usage.total_tokens", "llm.usage.total_tokens", "total_tokens"]),
    cacheReadTokens: tokenAttr(input.attrs, ["gen_ai.usage.cached_tokens", "gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.input_tokens_details.cached_tokens"]),
    reasoningTokens: tokenAttr(input.attrs, ["gen_ai.usage.reasoning_tokens", "gen_ai.usage.output_tokens_details.reasoning_tokens"]),
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
  if (!orgMembershipId || !inferenceKeyId || !openworkRequestId || !reportedModel) {
    return null
  }
  const generationId = stringAttr(attrs, ["gen_ai.response.id", "gen_ai.generation.id", "generation_id", "response_id"])
  const externalEventId = stringAttr(attrs, ["event_id", "id", "span_id"]) ?? generationId ?? spanString(span, "spanId")

  const occurredAt = timeFromSpan(span, attrs)
  const currency = stringAttr(attrs, ["gen_ai.usage.currency", "gen_ai.cost.currency"])
  if (!occurredAt || (currency !== null && currency !== "USD")) return null
  return {
    orgMembershipId,
    inferenceKeyId,
    openworkRequestId,
    externalEventId,
    generationId,
    occurredAt,
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
  let invalidUsage = 0
  if (!isRecord(body)) return { spans, invalidUsage }
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
        else if (Object.keys(attributesToRecord(span.attributes)).some((key) => key.startsWith("gen_ai.usage."))) invalidUsage += 1
      }
    }
  }
  return { spans, invalidUsage }
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

const ledgerSelection = {
  id: InferenceUsageLedgerEntryTable.id,
  organizationId: InferenceUsageLedgerEntryTable.organization_id,
  memberId: InferenceUsageLedgerEntryTable.org_membership_id,
  inferenceKeyId: InferenceUsageLedgerEntryTable.inference_key_id,
  requestId: InferenceUsageLedgerEntryTable.external_job_id,
  costAmount: InferenceUsageLedgerEntryTable.cost_amount,
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
    const [event] = await db.select(ledgerSelection).from(InferenceUsageLedgerEntryTable)
      .where(eq(InferenceUsageLedgerEntryTable.external_event_id, externalEventId))
      .limit(1)
    return event ?? null
  },
  async findOpenRouterUsageLedgerEntry(openworkRequestId) {
    const [existing] = await db.select(ledgerSelection).from(InferenceUsageLedgerEntryTable)
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
      model_id: input.span.reportedModel,
      provider_id: "openrouter",
      input_tokens: input.span.usageMetadata.inputTokens,
      output_tokens: input.span.usageMetadata.outputTokens,
      total_tokens: input.span.usageMetadata.totalTokens,
      event_type: input.unpriced ? "openrouter_usage_unpriced" : "openrouter_usage",
      provider_usage: {
        source: "openrouter_otlp",
        status: input.unpriced ? "unpriced" : "settled",
        requestModel: input.span.requestModel,
        responseModel: input.span.responseModel,
        inputCost: input.span.inputCost,
        outputCost: input.span.outputCost,
        currency: input.span.usageMetadata.currency,
        cacheReadTokens: input.span.usageMetadata.cacheReadTokens,
        reasoningTokens: input.span.usageMetadata.reasoningTokens,
      },
      occurred_at: input.span.occurredAt,
    }).onDuplicateKeyUpdate({ set: { id: sql`${InferenceUsageLedgerEntryTable.id}` } })
    const [entry] = await db.select(ledgerSelection).from(InferenceUsageLedgerEntryTable).where(and(
      eq(InferenceUsageLedgerEntryTable.external_job_id, input.span.openworkRequestId),
      eq(InferenceUsageLedgerEntryTable.event_type, input.unpriced ? "openrouter_usage_unpriced" : "openrouter_usage"),
    )).limit(1)
    if (!entry) throw new Error("Usage event identity conflict")
    return entry
  },
  async chargeBuckets(input) {
    await db.transaction(async (tx) => {
      // A per-entry row lock serializes duplicate deliveries, including recovery
      // after the ledger insert succeeded but the bucket transaction failed.
      const [entry] = await tx.select(ledgerSelection).from(InferenceUsageLedgerEntryTable)
        .where(eq(InferenceUsageLedgerEntryTable.id, input.ledgerEntryId)).limit(1).for("update")
      if (!entry) throw new Error("Usage entry missing")
      for (const [windowType, bucketId] of Object.entries(input.limits.bucketIds).sort(([left], [right]) => left.localeCompare(right))) {
        if (!bucketId) continue
        const limitAmount = input.limits.bucketLimits[windowType]
        if (limitAmount === undefined) continue
        const [bucket] = await tx.select({ id: InferenceOrgUsageBucketTable.id }).from(InferenceOrgUsageBucketTable)
          .where(and(eq(InferenceOrgUsageBucketTable.id, bucketId), eq(InferenceOrgUsageBucketTable.organization_id, entry.organizationId)))
          .limit(1).for("update")
        if (!bucket) throw new Error("Usage bucket identity conflict")
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
          amount: entry.costAmount,
        })
        await tx.update(InferenceOrgUsageBucketTable).set({
          used_amount: sql`${InferenceOrgUsageBucketTable.used_amount} + ${entry.costAmount}`,
        }).where(eq(InferenceOrgUsageBucketTable.id, bucketId))
      }
    })
  },
}

function reportUnknownPricedModel(input: { span: ParsedSpan; inferenceKey: WebhookInferenceKey; reporter: OpenRouterUsageWebhookReporter }) {
  logWebhookError("retained unpriced provider usage", {
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
  if (!inferenceKey || (inferenceKey.status !== "active" && (!inferenceKey.revoked_at || span.occurredAt > inferenceKey.revoked_at))) {
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
    const entry = await dependencies.insertOpenRouterUsageLedgerEntry({ inferenceKey, span, costAmount: 0, unpriced: true })
    if (entry.organizationId !== inferenceKey.organization_id || entry.memberId !== inferenceKey.org_membership_id || entry.inferenceKeyId !== inferenceKey.id || entry.requestId !== span.openworkRequestId) throw new Error("Usage entry identity conflict")
    reportUnknownPricedModel({ span, inferenceKey, reporter: dependencies.reporter })
    return true
  }

  const limits = await dependencies.ensureUsableBuckets(inferenceKey.organization_id, span.occurredAt)
  if (!limits.ok) throw new Error("Historical usage windows are unavailable")

  if (span.externalEventId) {
    const event = await dependencies.findLedgerEntryByExternalEventId(span.externalEventId)
    if (event && (event.requestId !== span.openworkRequestId || event.inferenceKeyId !== inferenceKey.id)) throw new Error("Usage event identity conflict")
  }

  const existing = await dependencies.findOpenRouterUsageLedgerEntry(span.openworkRequestId)
  const entry = existing ?? await dependencies.insertOpenRouterUsageLedgerEntry({ inferenceKey, span, costAmount })
  if (entry.organizationId !== inferenceKey.organization_id || entry.memberId !== inferenceKey.org_membership_id || entry.inferenceKeyId !== inferenceKey.id || entry.requestId !== span.openworkRequestId) throw new Error("Usage entry identity conflict")
  await dependencies.chargeBuckets({ limits, ledgerEntryId: entry.id, costAmount: entry.costAmount })
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

    const body = await c.req.json().catch(() => {
      logWebhookError("failed to parse webhook JSON")
      return null
    })
    if (!isRecord(body) || !Array.isArray(body.resourceSpans)) return c.json({ error: "invalid_usage_payload" }, 400)
    const { spans, invalidUsage } = parseOtlpSpans(body)
    let ingested = 0
    let skipped = 0
    let failed = invalidUsage
    if (invalidUsage) logWebhookError("Usage spans lack valid attribution or timing; provider must retry", { count: invalidUsage })
    for (const span of spans) {
      try {
        if (await ingestSpan(span, dependencies)) {
          ingested += 1
        } else {
          skipped += 1
        }
      } catch (error) {
        failed += 1
        logWebhookError("Usage settlement failed; provider must retry", { requestId: span.openworkRequestId })
      }
    }
    return c.json({ ok: failed === 0, ingested, skipped, failed }, failed ? 503 : 200)
  })
}
