import { randomUUID } from "node:crypto"
import type { WorkerTable } from "@openwork-ee/den-db/schema"

export type CloudStartupFailureStage = "provisioning" | "recovery" | "runtime"

export type CloudStartupFailureCode =
  | "access_tokens_missing"
  | "provider_capacity_unavailable"
  | "provider_operation_failed"
  | "provider_rate_limited"
  | "preview_expired"
  | "provisioning_timeout"
  | "runtime_health_timeout"
  | "runtime_start_failed"
  | "runtime_unreachable"
  | "sandbox_missing"
  | "sandbox_start_failed"
  | "storage_unavailable"

export type CloudStartupFailure = {
  code: CloudStartupFailureCode
  stage: CloudStartupFailureStage
  reference: string
  occurredAt: Date
}

export type PublicCloudStartupFailure = {
  code: CloudStartupFailureCode
  stage: CloudStartupFailureStage
  reference: string
  occurredAt: string
}

type CloudFailureWorker = Pick<
  typeof WorkerTable.$inferSelect,
  "cloud_failure_code" | "cloud_failure_stage" | "cloud_failure_reference" | "cloud_failure_at"
>

const cloudFailureCodes: ReadonlySet<string> = new Set([
  "access_tokens_missing",
  "provider_capacity_unavailable",
  "provider_operation_failed",
  "provider_rate_limited",
  "preview_expired",
  "provisioning_timeout",
  "runtime_health_timeout",
  "runtime_start_failed",
  "runtime_unreachable",
  "sandbox_missing",
  "sandbox_start_failed",
  "storage_unavailable",
])

const cloudFailureStages: ReadonlySet<string> = new Set(["provisioning", "recovery", "runtime"])

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : ""
}

export function classifyCloudStartupFailure(error: unknown): CloudStartupFailureCode {
  const message = errorMessage(error)
  if (/\b429\b|rate[ -]?limit|too many requests/.test(message)) return "provider_rate_limited"
  if (/quota|capacity|insufficient (cpu|memory|disk)|resource exhausted|no available/.test(message)) {
    return "provider_capacity_unavailable"
  }
  if (message.includes("provisioning deadline") || message.includes("cloud wake") && message.includes("deadline")) {
    return "provisioning_timeout"
  }
  if (message.includes("timed out waiting for daytona worker health")) return "runtime_health_timeout"
  if (message.includes("openwork session exited") || message.includes("binary missing")) return "runtime_start_failed"
  if (message.includes("sandbox") && message.includes("not found")) return "sandbox_missing"
  if (message.includes("start failed") || message.includes("sandbox") && message.includes("state change")) {
    return "sandbox_start_failed"
  }
  if (message.includes("volume") && (message.includes("timed out") || message.includes("unavailable"))) {
    return "storage_unavailable"
  }
  return "provider_operation_failed"
}

export function createCloudStartupFailure(input: {
  stage: CloudStartupFailureStage
  error: unknown
  now?: () => Date
}): CloudStartupFailure {
  return {
    code: classifyCloudStartupFailure(input.error),
    stage: input.stage,
    reference: `cwf_${randomUUID()}`,
    occurredAt: (input.now ?? (() => new Date()))(),
  }
}

export function createKnownCloudStartupFailure(input: {
  code: CloudStartupFailureCode
  stage: CloudStartupFailureStage
  now?: () => Date
}): CloudStartupFailure {
  return {
    code: input.code,
    stage: input.stage,
    reference: `cwf_${randomUUID()}`,
    occurredAt: (input.now ?? (() => new Date()))(),
  }
}

export function cloudStartupFailureUpdate(failure: CloudStartupFailure | null) {
  return failure
    ? {
        cloud_failure_code: failure.code,
        cloud_failure_stage: failure.stage,
        cloud_failure_reference: failure.reference,
        cloud_failure_at: failure.occurredAt,
      }
    : {
        cloud_failure_code: null,
        cloud_failure_stage: null,
        cloud_failure_reference: null,
        cloud_failure_at: null,
      }
}

function isCloudStartupFailureCode(value: string): value is CloudStartupFailureCode {
  return cloudFailureCodes.has(value)
}

function isCloudStartupFailureStage(value: string): value is CloudStartupFailureStage {
  return cloudFailureStages.has(value)
}

export function cloudStartupFailureFromWorker(worker: Partial<CloudFailureWorker>): CloudStartupFailure | null {
  const code = worker.cloud_failure_code
  const stage = worker.cloud_failure_stage
  const reference = worker.cloud_failure_reference?.trim() ?? ""
  const occurredAt = worker.cloud_failure_at
  if (!code || !isCloudStartupFailureCode(code)) return null
  if (!stage || !isCloudStartupFailureStage(stage)) return null
  if (!reference || !(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) return null
  return {
    code,
    stage,
    reference,
    occurredAt,
  }
}

export function publicCloudStartupFailure(failure: CloudStartupFailure): PublicCloudStartupFailure {
  return {
    code: failure.code,
    stage: failure.stage,
    reference: failure.reference,
    occurredAt: failure.occurredAt.toISOString(),
  }
}
