import { InferenceRequestLogTable } from "@openwork-ee/den-db"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type {
  InferenceRequestOutcome,
  InferenceRequestProtocol,
  InferenceRequestRoute,
  InferenceUsageSource,
} from "@openwork/types/den/inference"
import type { InferenceReporter } from "./inference-reporting.js"
import type { InferenceContext } from "./middleware/inference-auth.js"

export type InferenceRequestLogRow = typeof InferenceRequestLogTable.$inferInsert

export type InsertRequestLog = (row: InferenceRequestLogRow) => Promise<void>

export type RequestLogStartInput = {
  identity: Pick<InferenceContext, "organizationId" | "orgMembershipId" | "inferenceKeyId">
  openworkRequestId: string
  route: InferenceRequestRoute
  protocol: InferenceRequestProtocol
  upstreamProviderId: string
  upstreamHost: string
  upstreamPath: string
  method: string
  requestedModel: string | null
  upstreamModel: string | null
  stream: boolean
  inferenceProviderId?: InferenceRequestLogRow["inference_provider_id"]
  inferenceProviderCredentialId?: InferenceRequestLogRow["inference_provider_credential_id"]
  requestBytes?: number | null
  startedAt?: Date
}

export type RequestLogUsageInput = {
  usageSource: InferenceUsageSource
  upstreamModel?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
  costUsd?: number | null
}

export type RequestLogFinishInput = {
  status: number | null
  outcome: InferenceRequestOutcome
  errorCode?: string | null
  upstreamRequestId?: string | null
  responseBytes?: number | null
}

export type RequestLogRecorderDependencies = {
  insertRequestLog: InsertRequestLog
  reporter: InferenceReporter
  now?: () => Date
}

export type RequestLogRecorder = {
  start(input: RequestLogStartInput): void
  markFirstByte(): void
  setUsage(input: RequestLogUsageInput): void
  finish(input: RequestLogFinishInput): Promise<void>
}

export const insertRequestLogIntoDb: InsertRequestLog = async (row) => {
  const { db } = await import("./db.js")
  await db.insert(InferenceRequestLogTable).values(row)
}

function totalTokens(usage: RequestLogUsageInput) {
  if (typeof usage.totalTokens === "number") return usage.totalTokens
  if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") {
    return usage.inputTokens + usage.outputTokens
  }
  return null
}

function costMicroUsd(costUsd: number | null | undefined) {
  return typeof costUsd === "number" && Number.isFinite(costUsd) ? Math.round(costUsd * 1_000_000) : null
}

export function createRequestLogRecorder(dependencies: RequestLogRecorderDependencies): RequestLogRecorder {
  const now = dependencies.now ?? (() => new Date())
  let started: RequestLogStartInput | null = null
  let startedAt: Date | null = null
  let firstByteAt: Date | null = null
  let usage: RequestLogUsageInput | null = null
  let finished = false

  return {
    start(input) {
      started = input
      startedAt = input.startedAt ?? now()
    },
    markFirstByte() {
      if (!firstByteAt) firstByteAt = now()
    },
    setUsage(input) {
      usage = input
    },
    async finish(input) {
      if (finished || !started || !startedAt) return
      finished = true
      const row: InferenceRequestLogRow = {
        id: createDenTypeId("inferenceRequestLog"),
        organization_id: started.identity.organizationId,
        org_membership_id: started.identity.orgMembershipId,
        inference_key_id: started.identity.inferenceKeyId,
        inference_provider_id: started.inferenceProviderId ?? null,
        inference_provider_credential_id: started.inferenceProviderCredentialId ?? null,
        route: started.route,
        protocol: started.protocol,
        upstream_provider_id: started.upstreamProviderId,
        upstream_host: started.upstreamHost,
        upstream_path: started.upstreamPath,
        method: started.method,
        requested_model: started.requestedModel,
        upstream_model: usage?.upstreamModel ?? started.upstreamModel,
        stream: started.stream,
        status: input.status,
        outcome: input.outcome,
        error_code: input.errorCode ?? null,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        total_tokens: usage ? totalTokens(usage) : null,
        cache_read_tokens: usage?.cacheReadTokens ?? null,
        cache_write_tokens: usage?.cacheWriteTokens ?? null,
        reasoning_tokens: usage?.reasoningTokens ?? null,
        usage_source: usage?.usageSource ?? "missing",
        cost_micro_usd: costMicroUsd(usage?.costUsd),
        upstream_request_id: input.upstreamRequestId ?? null,
        openwork_request_id: started.openworkRequestId,
        started_at: startedAt,
        first_byte_at: firstByteAt,
        completed_at: now(),
        request_bytes: started.requestBytes ?? null,
        response_bytes: input.responseBytes ?? null,
        metadata: null,
      }
      try {
        await dependencies.insertRequestLog(row)
      } catch (error) {
        console.error("[inference-proxy] Failed to insert inference request log", {
          openworkRequestId: started.openworkRequestId,
          organizationId: started.identity.organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
        dependencies.reporter.handledError({
          reason: "request_log_insert_failed",
          organizationId: started.identity.organizationId,
          orgMembershipId: started.identity.orgMembershipId,
          inferenceKeyId: started.identity.inferenceKeyId,
          openworkRequestId: started.openworkRequestId,
          route: started.upstreamPath,
          method: started.method,
          incomingModel: started.requestedModel,
          resolvedUpstreamModel: row.upstream_model,
          error: error instanceof Error ? error.message : String(error),
          exception: error,
        })
      }
    },
  }
}
