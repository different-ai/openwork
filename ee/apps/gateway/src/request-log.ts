import { GatewayRequestLogTable } from "@openwork-ee/den-db"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type {
  GatewayRequestOutcome,
  GatewayRequestProtocol,
  GatewayRequestRoute,
  GatewayUsageSource,
} from "@openwork/types/den/gateway"
import type { InferenceReporter } from "./inference-reporting.js"
import type { InferenceContext } from "./middleware/inference-auth.js"
import type { GatewayContext } from "./middleware/gateway-auth.js"
import { estimateCostMicroUsd, loadPricingCatalogFromFile } from "./pricing.js"
import type { PricingCatalog } from "./pricing.js"
import type { GenerationTerminal } from "./generation-outcome.js"
import { terminalErrorCode, validatedUpstreamId } from "./generation-outcome.js"

export type GatewayRequestLogRow = typeof GatewayRequestLogTable.$inferInsert

export type InsertRequestLog = (row: GatewayRequestLogRow) => Promise<void>
export type UpdateRequestLog = (row: GatewayRequestLogRow) => Promise<boolean>

export type RequestLogStartInput = {
  identity: Pick<InferenceContext, "kind" | "organizationId" | "orgMembershipId" | "inferenceKeyId"> | GatewayContext
  openworkRequestId: string
  route: GatewayRequestRoute
  protocol: GatewayRequestProtocol
  upstreamProviderId: string
  upstreamHost: string
  upstreamPath: string
  method: string
  requestedModel: string | null
  upstreamModel: string | null
  modelAlias?: string | null
  stream: boolean
  gatewayProviderId?: GatewayRequestLogRow["gateway_provider_id"]
  gatewayProviderCredentialId?: GatewayRequestLogRow["gateway_provider_credential_id"]
  modelGroupId?: GatewayRequestLogRow["model_group_id"]
  credentialSetId?: GatewayRequestLogRow["credential_set_id"]
  accessGrantId?: GatewayRequestLogRow["access_grant_id"]
  requestBytes?: number | null
  startedAt?: Date
}

export type RequestLogUsageInput = {
  generation?: GenerationTerminal
  usageSource: GatewayUsageSource
  upstreamModel?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
  costUsd?: number | null
  upstreamRequestId?: string | null
  streamError?: "upstream_stream_error"
}

export type RequestLogFinishInput = {
  status: number | null
  outcome: GatewayRequestOutcome
  errorCode?: string | null
  upstreamRequestId?: string | null
  responseBytes?: number | null
  firstOutputMs?: number | null
}

export type RequestLogRecorderDependencies = {
  insertRequestLog: InsertRequestLog
  // Must update by id only, never upsert: retention may already have consumed
  // an abandoned pending row. False means there is no row left to finalize.
  updateRequestLog?: UpdateRequestLog
  reporter: InferenceReporter
  now?: () => Date
  pricing?: PricingCatalog
}

export type RequestLogRecorder = {
  start(input: RequestLogStartInput): void
  // Optional for existing recorder mocks. The real recorder always exposes it.
  // Gateway must await true BEFORE forwarding to make write-ahead a guarantee.
  whenStarted?(): Promise<boolean>
  markFirstByte(): void
  setUsage(input: RequestLogUsageInput): void
  finish(input: RequestLogFinishInput): Promise<void>
}

export const insertRequestLogIntoDb: InsertRequestLog = async (row) => {
  const { db } = await import("./db.js")
  await db.insert(GatewayRequestLogTable).values(row)
    .onDuplicateKeyUpdate({ set: { id: sql`${GatewayRequestLogTable.id}` } })
}

export async function updateRequestLogInDb(row: GatewayRequestLogRow): Promise<boolean> {
  const { db } = await import("./db.js")
  // A transaction/locking read also distinguishes a no-op retry from a missing
  // row without relying on driver-specific affectedRows/CLIENT_FOUND_ROWS.
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: GatewayRequestLogTable.id }).from(GatewayRequestLogTable)
      .where(eq(GatewayRequestLogTable.id, row.id)).for("update")
    if (!existing) return false
    await tx.update(GatewayRequestLogTable).set(row).where(eq(GatewayRequestLogTable.id, row.id))
    return true
  })
}

function totalTokens(usage: RequestLogUsageInput, protocol: GatewayRequestProtocol) {
  if (typeof usage.totalTokens === "number") return usage.totalTokens
  if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
    return usage.inputTokens + usage.outputTokens
      + (protocol === "anthropic_messages" || protocol === "bedrock_converse" ? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0)
      + (protocol === "google_generate_content" ? usage.reasoningTokens ?? 0 : 0)
  }
  return null
}

function costMicroUsd(costUsd: number | null | undefined) {
  return typeof costUsd === "number" && costUsd >= 0 && Number.isSafeInteger(Math.round(costUsd * 1_000_000)) ? Math.round(costUsd * 1_000_000) : null
}

function hasUsageTokens(usage: RequestLogUsageInput) {
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, usage.costUsd]
    .some((value) => typeof value === "number")
}

// Snapshot cost from models.dev pricing when the upstream did not report an
// authoritative cost (OpenRouter's usage.cost wins when present).
function estimateCost(started: RequestLogStartInput, usage: RequestLogUsageInput | null, upstreamModel: string | null, pricing: PricingCatalog) {
  const reported = costMicroUsd(usage?.costUsd)
  if (reported !== null) return reported
  if (!usage || !upstreamModel || !hasUsageTokens(usage)) return null
  return estimateCostMicroUsd({
    providerId: started.upstreamProviderId,
    modelId: upstreamModel,
    protocol: started.protocol,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
  }, pricing)
}

export function createRequestLogRecorder(dependencies: RequestLogRecorderDependencies): RequestLogRecorder {
  const now = dependencies.now ?? (() => new Date())
  let started: RequestLogStartInput | null = null
  let startedAt: Date | null = null
  let firstByteAt: Date | null = null
  let usage: RequestLogUsageInput | null = null
  let finished = false
  let pending: GatewayRequestLogRow | null = null
  let startWrite: Promise<boolean> = Promise.resolve(false)
  let finishWrite: Promise<void> | null = null

  function report(reason: string) {
    // DB exceptions frequently embed INSERT parameters (and upstream values).
    // No exception/message, arbitrary path, model or response body leaves here.
    try {
      dependencies.reporter.handledError({ reason, route: "request_log", method: "WRITE" })
    } catch {
      // A telemetry sink must never reject a relay callback or start promise.
    }
  }

  async function persist(write: () => Promise<boolean>, reason: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await write() } catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 25 : 100))
      }
    }
    report(reason)
    return false
  }

  return {
    start(input) {
      if (started) return
      started = input
      startedAt = input.startedAt ?? now()
      pending = {
        id: createDenTypeId("inferenceRequestLog"),
        organization_id: input.identity.organizationId,
        org_membership_id: input.identity.orgMembershipId,
        inference_key_id: input.identity.kind === "models" ? input.identity.inferenceKeyId : null,
        gateway_key_id: input.identity.kind === "gateway" ? input.identity.gatewayKeyId : null,
        gateway_provider_id: input.identity.kind === "gateway" ? input.gatewayProviderId ?? null : null,
        gateway_provider_credential_id: input.identity.kind === "gateway" ? input.gatewayProviderCredentialId ?? null : null,
        model_group_id: input.identity.kind === "gateway" ? input.modelGroupId ?? null : null,
        credential_set_id: input.identity.kind === "gateway" ? input.credentialSetId ?? null : null,
        access_grant_id: input.identity.kind === "gateway" ? input.accessGrantId ?? null : null,
        route: input.route, protocol: input.protocol,
        upstream_provider_id: input.upstreamProviderId, upstream_host: input.upstreamHost,
        upstream_path: input.upstreamPath, method: input.method,
        requested_model: input.requestedModel, upstream_model: input.upstreamModel,
        stream: input.stream, started_at: startedAt, completed_at: null,
        // Existing enum placeholder; completed_at NULL is the pending marker.
        outcome: "client_aborted", usage_source: "missing",
        openwork_request_id: input.openworkRequestId, request_bytes: input.requestBytes ?? null,
      }
      const row = pending
      startWrite = persist(async () => { await dependencies.insertRequestLog(row); return true }, "request_log_insert_failed")
    },
    whenStarted() {
      return startWrite
    },
    markFirstByte() {
      if (!firstByteAt) firstByteAt = now()
    },
    setUsage(input) {
      usage = input
    },
    finish(input) {
      if (finishWrite) return finishWrite
      if (finished || !started || !startedAt || !pending) return Promise.resolve()
      finished = true
      let pricing: PricingCatalog
      try { pricing = dependencies.pricing ?? loadPricingCatalogFromFile() } catch {
        report("request_log_pricing_unavailable")
        pricing = { getModelPrice: () => null }
      }
      const upstreamModel = usage?.upstreamModel ?? started.upstreamModel
        ?? (started.identity.kind === "models" && started.protocol !== "passthrough" ? started.requestedModel : null)
      const completedAt = now()
      const generationOutcome = usage?.generation?.generationOutcome ?? "unknown"
      const providerTerminalReason = usage?.generation?.providerTerminalReason ?? "unknown"
      const row: GatewayRequestLogRow = {
        id: pending.id,
        organization_id: started.identity.organizationId,
        org_membership_id: started.identity.orgMembershipId,
        inference_key_id: pending.inference_key_id,
        gateway_key_id: pending.gateway_key_id,
        gateway_provider_id: pending.gateway_provider_id,
        gateway_provider_credential_id: pending.gateway_provider_credential_id,
        model_group_id: pending.model_group_id,
        credential_set_id: pending.credential_set_id,
        access_grant_id: pending.access_grant_id,
        route: started.route,
        protocol: started.protocol,
        upstream_provider_id: started.upstreamProviderId,
        upstream_host: started.upstreamHost,
        upstream_path: started.upstreamPath,
        method: started.method,
        requested_model: started.requestedModel,
        upstream_model: upstreamModel,
        stream: started.stream,
        status: input.status,
        outcome: input.outcome === "ok" && usage?.streamError ? "upstream_error" : input.outcome,
        generation_outcome: generationOutcome,
        provider_terminal_reason: providerTerminalReason,
        error_code: input.errorCode ?? usage?.streamError ?? null,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        total_tokens: usage ? totalTokens(usage, started.protocol) : null,
        cache_read_tokens: usage?.cacheReadTokens ?? null,
        cache_write_tokens: usage?.cacheWriteTokens ?? null,
        reasoning_tokens: usage?.reasoningTokens ?? null,
        usage_source: usage && hasUsageTokens(usage) ? usage.usageSource : "missing",
        cost_micro_usd: estimateCost(started, usage, upstreamModel, pricing),
        upstream_request_id: validatedUpstreamId(input.upstreamRequestId) ?? validatedUpstreamId(usage?.upstreamRequestId),
        openwork_request_id: started.openworkRequestId,
        started_at: startedAt,
        first_byte_at: firstByteAt,
        completed_at: completedAt,
        request_bytes: started.requestBytes ?? null,
        response_bytes: input.responseBytes ?? null,
        metadata: { cost_source: costMicroUsd(usage?.costUsd) !== null ? "upstream" : "catalog_estimate" },
      }
      if (row.cost_micro_usd === null) row.metadata = { cost_source: "unknown" }
      const upstreamResponseId = validatedUpstreamId(usage?.upstreamRequestId)
      if (upstreamResponseId) row.metadata = { ...row.metadata, upstream_response_id: upstreamResponseId }
      try {
        dependencies.reporter.terminal?.({
          openworkRequestId: started.openworkRequestId,
          upstreamRequestId: row.upstream_request_id ?? null,
          upstreamResponseId, firstOutputMs: input.firstOutputMs ?? null,
          organizationId: started.identity.organizationId,
          orgMembershipId: started.identity.orgMembershipId,
          route: started.route, protocol: started.protocol,
          upstreamProviderId: started.upstreamProviderId,
          modelAlias: started.modelAlias ?? null,
          status: input.status, transportOutcome: row.outcome, errorCode: terminalErrorCode(row.error_code),
          generationOutcome, providerTerminalReason,
          startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          responseBytes: input.responseBytes ?? null,
          inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        })
      } catch {}
      finishWrite = (async () => {
        if (!await startWrite) return
        const saved = await persist(() => (dependencies.updateRequestLog ?? updateRequestLogInDb)(row), "request_log_update_failed")
        if (!saved) report("request_log_not_finalized")
      })()
      return finishWrite
    },
  }
}
