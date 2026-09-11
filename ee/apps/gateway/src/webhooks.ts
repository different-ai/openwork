import { and, asc, eq, gt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import type { Hono } from "hono"
import { InferenceKeyTable, InferenceOrgLimitPolicyTable, InferenceUsageLedgerBucketChargeTable, InferenceUsageLedgerEntryTable, InferenceOrgUsageBucketTable } from "@openwork-ee/den-db"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_USAGE_CONVERSION_FACTOR, INFERENCE_WINDOW_TYPES } from "@openwork/types/den/inference"
import * as Sentry from "@sentry/node"
import { db } from "./db.js"
import { env } from "./env.js"
import { constantTimeEquals } from "./keys.js"
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
  revoked_at: Date | null
  organization_id: DenTypeId<"organization">
  org_membership_id: DenTypeId<"member">
}

type SettleUsageInput = {
  inferenceKey: WebhookInferenceKey
  span: ParsedSpan
  costAmount: number | null
}

type WebhookDependencies = {
  reporter: OpenRouterUsageWebhookReporter
  findInferenceKey(inferenceKeyId: string): Promise<WebhookInferenceKey | null>
  settleUsage(input: SettleUsageInput): Promise<"ingested" | "deferred" | "skipped">
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
    const numberValue = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
    if (Number.isFinite(numberValue) && numberValue >= 0) return numberValue
  }
  return null
}

function spanString(span: JsonRecord, key: string) {
  const value = span[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
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
  let date: Date
  if (admittedAt) {
    date = new Date(admittedAt)
  } else {
    const raw = stringAttr(span, ["startTimeUnixNano", "endTimeUnixNano", "timeUnixNano"])
    if (!raw || !/^\d{1,20}$/.test(raw)) return null
    date = new Date(Number(BigInt(raw) / 1_000_000n))
  }
  return Number.isFinite(date.getTime()) && date.getTime() > 0 && date.getTime() <= 2_147_483_647_000 ? date : null
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

function parseSpan(span: JsonRecord, attrs: JsonRecord): ParsedSpan | null {
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
  const usageMetadata = usageMetadataFromSpan({ span, attrs, requestModel, responseModel, inputCost, outputCost, generationId })
  if (!occurredAt || [openworkRequestId, reportedModel, externalEventId].some((value) => value !== null && value.length > 255)) return null
  if (usageMetadata.currency !== null && usageMetadata.currency !== "USD") return null
  for (const name of ["gen_ai.usage.input_cost", "gen_ai.usage.output_cost"]) {
    const value = attrs[name]
    const missing = value == null || (typeof value === "string" && value.trim() === "")
    if (!missing && numberAttr(attrs, [name]) === null) return null
  }
  if (usageMetadata.totalCost !== null && !Number.isFinite(usageMetadata.totalCost)) return null
  for (const name of Object.keys(attrs).filter((key) => /^(gen_ai\.usage\.|llm\.usage\.)?(input|output|prompt|completion|total)_tokens$/.test(key))) {
    const value = numberAttr(attrs, [name])
    if (value === null || !Number.isSafeInteger(value) || value > 2_147_483_647) return null
  }
  try {
    normalizeDenTypeId("member", orgMembershipId)
    normalizeDenTypeId("inferenceKey", inferenceKeyId)
  } catch { return null }

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
    usageMetadata,
  }
}

function parseOtlpSpans(body: unknown) {
  const spans: ParsedSpan[] = []
  let invalid = 0
  if (!isRecord(body)) return { spans, invalid }
  for (const resourceSpan of values(body.resourceSpans)) {
    if (!isRecord(resourceSpan)) continue
    const resourceAttrs = attributesToRecord(isRecord(resourceSpan.resource) ? resourceSpan.resource.attributes : undefined)
    for (const scopeSpan of values(resourceSpan.scopeSpans)) {
      if (!isRecord(scopeSpan)) continue
      const scopeAttrs = attributesToRecord(isRecord(scopeSpan.scope) ? scopeSpan.scope.attributes : undefined)
      for (const span of values(scopeSpan.spans)) {
        if (!isRecord(span)) continue
        const attrs = { ...resourceAttrs, ...scopeAttrs, ...attributesToRecord(span.attributes) }
        const parsed = parseSpan(span, attrs)
        if (parsed) spans.push(parsed)
        else if (Object.keys(attrs).some((key) => key.startsWith("gen_ai.usage."))) invalid += 1
      }
    }
  }
  return { spans, invalid }
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
  async settleUsage({ inferenceKey, span, costAmount }) {
    return db.transaction(async (tx) => {
      // Shared with both bucket writers and admin reset. Historical settlement
      // never provisions access, changes a limit, or advances a current pointer.
      const policies = await tx.select().from(InferenceOrgLimitPolicyTable)
        .where(eq(InferenceOrgLimitPolicyTable.organization_id, inferenceKey.organization_id))
        .orderBy(asc(InferenceOrgLimitPolicyTable.window_type)).for("update")
      const identity = or(
        and(eq(InferenceUsageLedgerEntryTable.external_job_id, span.openworkRequestId), eq(InferenceUsageLedgerEntryTable.event_type, "openrouter_usage")),
        span.externalEventId ? eq(InferenceUsageLedgerEntryTable.external_event_id, span.externalEventId) : undefined,
      )
      const matchesIdentity = (entry: typeof InferenceUsageLedgerEntryTable.$inferSelect) =>
        entry.organization_id === inferenceKey.organization_id && entry.org_membership_id === inferenceKey.org_membership_id &&
        entry.inference_key_id === inferenceKey.id && entry.external_job_id === span.openworkRequestId && entry.event_type === "openrouter_usage"
      const existing = await tx.select().from(InferenceUsageLedgerEntryTable).where(identity).for("update")
      if (existing.some((entry) => !matchesIdentity(entry))) return "skipped"
      const occurredAt = existing[0]?.occurred_at ?? span.occurredAt
      if (inferenceKey.status !== "active" && (!inferenceKey.revoked_at || occurredAt > inferenceKey.revoked_at)) return "skipped"
      const providerUsage = {
        source: "openrouter_otlp" as const,
        status: costAmount === null ? "unpriced" as const : "priced" as const,
        requestModel: span.requestModel, responseModel: span.responseModel,
        inputCost: span.inputCost, outputCost: span.outputCost, currency: span.usageMetadata.currency,
      }
      if (!existing[0]) {
        await tx.insert(InferenceUsageLedgerEntryTable).values({
          id: createDenTypeId("inferenceUsageLedgerEntry"),
          organization_id: inferenceKey.organization_id, org_membership_id: inferenceKey.org_membership_id,
          inference_key_id: inferenceKey.id, external_job_id: span.openworkRequestId, external_event_id: span.externalEventId,
          cost_amount: costAmount ?? 0, model_id: span.reportedModel, provider_id: "openrouter",
          input_tokens: span.usageMetadata.inputTokens, output_tokens: span.usageMetadata.outputTokens, total_tokens: span.usageMetadata.totalTokens,
          event_type: "openrouter_usage", occurred_at: occurredAt, provider_usage: providerUsage,
        }).onDuplicateKeyUpdate({ set: { id: sql`${InferenceUsageLedgerEntryTable.id}` } })
      }
      // A unique event can collide across organizations despite the policy lock.
      const entries = await tx.select().from(InferenceUsageLedgerEntryTable).where(identity).for("update")
      const entry = entries[0]
      if (!entry || entries.length !== 1 || !matchesIdentity(entry)) return "skipped"
      if (entry.provider_usage?.status === "unpriced" && costAmount !== null) {
        await tx.update(InferenceUsageLedgerEntryTable).set({ cost_amount: costAmount, provider_usage: providerUsage })
          .where(eq(InferenceUsageLedgerEntryTable.id, entry.id))
        entry.cost_amount = costAmount
        entry.provider_usage = providerUsage
      }
      if (entry.provider_usage?.status === "unpriced") return "deferred"

      const buckets: typeof InferenceOrgUsageBucketTable.$inferSelect[] = []
      for (const policy of policies) {
        const matches = await tx.select().from(InferenceOrgUsageBucketTable).where(and(
          eq(InferenceOrgUsageBucketTable.policy_id, policy.id),
          eq(InferenceOrgUsageBucketTable.organization_id, entry.organization_id),
          lte(InferenceOrgUsageBucketTable.window_start_at, entry.occurred_at), gt(InferenceOrgUsageBucketTable.window_end_at, entry.occurred_at),
        )).orderBy(asc(InferenceOrgUsageBucketTable.id)).limit(2).for("update")
        // Older writers could create overlapping windows. Do not guess which
        // allowance owns this usage; retain it until that history is repaired.
        if (matches.length !== 1) return "deferred"
        buckets.push(matches[0]!)
      }
      // Missing historical windows are durably deferred, not invented using
      // today's entitlement. Provider retries remain safe if history is repaired.
      if (buckets.length !== INFERENCE_WINDOW_TYPES.length) return "deferred"
      for (const bucket of buckets) {
        const [charge] = await tx.select().from(InferenceUsageLedgerBucketChargeTable).where(and(
          eq(InferenceUsageLedgerBucketChargeTable.ledger_entry_id, entry.id), eq(InferenceUsageLedgerBucketChargeTable.bucket_id, bucket.id),
        )).limit(1).for("update")
        if (charge) continue // Includes admin-forgiven zero-amount identities.
        // Before provider facts existed, reset deleted identities. A legacy gap
        // cannot safely be distinguished from forgiveness, so never backfill it.
        if (entry.provider_usage === null) return "deferred"
        if (!Number.isSafeInteger(bucket.used_amount + entry.cost_amount)) throw new Error("Usage total exceeds safe integer range")
        await tx.insert(InferenceUsageLedgerBucketChargeTable).values({
          id: createDenTypeId("inferenceUsageLedgerBucketCharge"), ledger_entry_id: entry.id, bucket_id: bucket.id, amount: entry.cost_amount,
        })
        await tx.update(InferenceOrgUsageBucketTable).set({ used_amount: sql`${InferenceOrgUsageBucketTable.used_amount} + ${entry.cost_amount}` })
          .where(eq(InferenceOrgUsageBucketTable.id, bucket.id))
      }
      return "ingested"
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
  // Settlement may arrive after revocation; settleUsage checks admission time.
  if (!inferenceKey) {
    return "skipped"
  }
  if (inferenceKey.org_membership_id !== normalizeDenTypeId("member", span.orgMembershipId)) {
    logWebhookError("skipped span for mismatched org membership", {
      inferenceKeyId: span.inferenceKeyId,
      spanOrgMembershipId: span.orgMembershipId,
      keyOrgMembershipId: inferenceKey.org_membership_id,
    })
    return "skipped"
  }

  const costAmount = usageUnitsForModel({ upstreamModel: span.reportedModel, inputCost: span.inputCost, outputCost: span.outputCost })
  const result = await dependencies.settleUsage({ inferenceKey, span, costAmount })
  if (costAmount === null && result === "deferred") {
    reportUnknownPricedModel({ span, inferenceKey, reporter: dependencies.reporter })
  }
  return result
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
    const { spans, invalid } = parseOtlpSpans(body)
    let ingested = 0
    let skipped = 0
    let deferred = 0
    let failed = 0
    for (const span of spans) {
      try {
        const result = await ingestSpan(span, dependencies)
        if (result === "ingested") {
          ingested += 1
        } else if (result === "deferred") {
          deferred += 1
        } else {
          skipped += 1
        }
      } catch {
        failed += 1
        logWebhookError("Usage persistence failed; provider must retry", { requestId: span.openworkRequestId })
      }
    }
    return c.json({ ok: failed === 0 && invalid === 0, ingested, skipped, deferred, invalid, failed }, failed ? 503 : invalid ? 400 : 200)
  })
}
