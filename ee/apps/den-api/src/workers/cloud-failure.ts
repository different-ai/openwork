import { randomUUID } from "node:crypto"
import { runtimeProviderErrorCode } from "@openwork-ee/cloud-runtime/contract"
import { cloudRuntimeErrorCode } from "@openwork-ee/cloud-runtime/orchestrator"
import type { WorkerTable } from "@openwork-ee/den-db/schema"
import { OpenWorkWebAccessRequiredError } from "../openwork-web-access-error.js"

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
  | "web_access_required"

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
  "web_access_required",
])

const cloudFailureStages: ReadonlySet<string> = new Set(["provisioning", "recovery", "runtime"])

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : ""
}

function classifyRuntimeError(error: unknown): CloudStartupFailureCode | null {
  switch (cloudRuntimeErrorCode(error)) {
    case "runtime_health_timeout":
      return "runtime_health_timeout"
    case "runtime_start_failed":
      return "runtime_start_failed"
    case "instance_missing":
      return "sandbox_missing"
    case "instance_start_failed":
      return "sandbox_start_failed"
    case "checkpoint_not_restored":
      return "provider_operation_failed"
    case null:
      break
  }
  switch (runtimeProviderErrorCode(error)) {
    case "rate_limited":
      return "provider_rate_limited"
    case "capacity":
      return "provider_capacity_unavailable"
    case "not_found":
      return "sandbox_missing"
    case "invalid_state":
      return "sandbox_start_failed"
    default:
      return null
  }
}

export function classifyCloudStartupFailure(error: unknown): CloudStartupFailureCode {
  if (error instanceof OpenWorkWebAccessRequiredError) return "web_access_required"
  const message = errorMessage(error)
  // Storage waits surface as provider timeouts; keep them distinct from a
  // slow instance start.
  if (message.includes("volume") && (message.includes("timed out") || message.includes("unavailable"))) {
    return "storage_unavailable"
  }
  const typed = classifyRuntimeError(error)
  if (typed) return typed
  if (/\b429\b|rate[ -]?limit|too many requests/.test(message)) return "provider_rate_limited"
  if (/quota|capacity|insufficient (cpu|memory|disk)|resource exhausted|no available/.test(message)) {
    return "provider_capacity_unavailable"
  }
  if (message.includes("provisioning deadline") || message.includes("cloud wake") && message.includes("deadline")) {
    return "provisioning_timeout"
  }
  if (message.includes("timed out waiting for cloud runtime health") || message.includes("timed out waiting for daytona worker health")) {
    return "runtime_health_timeout"
  }
  if (message.includes("openwork session exited") || message.includes("binary missing")) return "runtime_start_failed"
  if (message.includes("sandbox") && message.includes("not found")) return "sandbox_missing"
  if (message.includes("start failed") || message.includes("sandbox") && message.includes("state change")) {
    return "sandbox_start_failed"
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
