import { gatewayUsagePeriod } from "@openwork/types/den/gateway-usage-limits"
import { GatewayUsageError } from "./gateway-usage-errors"
import type { GatewayUsageScope, UsageBucket } from "./gateway-usage-read"

export type UsageBucketSnapshot = Pick<
  UsageBucket,
  | "id"
  | "organizationId"
  | "memberId"
  | "timeframe"
  | "policyId"
  | "policyName"
  | "policyRevision"
  | "baseAllowanceMicroUsd"
  | "hardLimit"
  | "allowRequestReset"
> & { startAt: string; resetAt: string }
export type GatewayUsageSnapshot =
  | { version: 1; buckets: UsageBucketSnapshot[] }
  | { version: 2; admittedAt: string; trackingVersion?: number; buckets: UsageBucketSnapshot[] }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function validUsageDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}
function bucket(
  value: unknown,
  scope: GatewayUsageScope,
  admittedAt: Date,
): value is UsageBucketSnapshot {
  if (!object(value)) return false
  const fields = new Set([
    "id",
    "organizationId",
    "memberId",
    "timeframe",
    "policyId",
    "policyName",
    "policyRevision",
    "baseAllowanceMicroUsd",
    "hardLimit",
    "allowRequestReset",
    "startAt",
    "resetAt",
  ])
  if (Object.keys(value).some((key) => !fields.has(key))) return false
  if (
    !bounded(value.id, 64) ||
    value.organizationId !== scope.organizationId ||
    value.memberId !== scope.memberId ||
    !bounded(value.policyId, 64) ||
    !bounded(value.policyName, 120) ||
    typeof value.policyRevision !== "number" ||
    !Number.isInteger(value.policyRevision) ||
    value.policyRevision < 0 ||
    value.policyRevision > 2147483647 ||
    typeof value.baseAllowanceMicroUsd !== "number" ||
    !Number.isSafeInteger(value.baseAllowanceMicroUsd) ||
    value.baseAllowanceMicroUsd < 0 ||
    value.baseAllowanceMicroUsd > 7205759403792792 ||
    typeof value.hardLimit !== "boolean" ||
    typeof value.allowRequestReset !== "boolean" ||
    !validUsageDate(value.startAt) ||
    !validUsageDate(value.resetAt) ||
    (value.timeframe !== "day" && value.timeframe !== "week" && value.timeframe !== "month")
  )
    return false
  const period = gatewayUsagePeriod(value.timeframe, admittedAt)
  return value.startAt === period.start.toISOString() && value.resetAt === period.end.toISOString()
}

export function validateUsageSnapshot(
  value: unknown,
  scope: GatewayUsageScope,
  requestStartedAt: Date,
): GatewayUsageSnapshot {
  const invalid = () => {
    throw new GatewayUsageError(
      "invalid_attribution",
      409,
      "Invalid stored or reviewed usage attribution.",
    )
  }
  if (
    !Number.isFinite(requestStartedAt.getTime()) ||
    !object(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.buckets)
  )
    return invalid()
  if (
    Object.keys(value).some(
      (key) =>
        !(
          value.version === 2
            ? ["version", "buckets", "admittedAt", "trackingVersion"]
            : ["version", "buckets"]
        ).includes(key),
    )
  )
    return invalid()
  if (
    value.trackingVersion !== undefined &&
    (typeof value.trackingVersion !== "number" ||
      !Number.isInteger(value.trackingVersion) ||
      value.trackingVersion < 0 ||
      value.trackingVersion > 2147483647)
  )
    return invalid()
  const admittedAt =
    value.version === 2 && validUsageDate(value.admittedAt)
      ? new Date(value.admittedAt)
      : requestStartedAt
  if (
    value.version === 2 &&
    (!validUsageDate(value.admittedAt) ||
      admittedAt < requestStartedAt ||
      value.buckets.length !== 3)
  )
    return invalid()
  if (
    value.buckets.length > 3 ||
    !value.buckets.every((row): row is UsageBucketSnapshot => bucket(row, scope, admittedAt))
  )
    return invalid()
  if (new Set(value.buckets.map((row) => row.timeframe)).size !== value.buckets.length)
    return invalid()
  return value.version === 2
    ? {
        version: 2,
        admittedAt: admittedAt.toISOString(),
        ...(typeof value.trackingVersion === "number"
          ? { trackingVersion: value.trackingVersion }
          : {}),
        buckets: value.buckets,
      }
    : { version: 1, buckets: value.buckets }
}

export function sameUsageSnapshot(left: GatewayUsageSnapshot, right: GatewayUsageSnapshot) {
  const signature = (snapshot: GatewayUsageSnapshot) =>
    JSON.stringify([
      snapshot.version,
      snapshot.version === 2 ? snapshot.admittedAt : null,
      snapshot.version === 2 ? (snapshot.trackingVersion ?? null) : null,
      [...snapshot.buckets]
        .sort((a, b) => a.timeframe.localeCompare(b.timeframe))
        .map((b) => [
          b.id,
          b.organizationId,
          b.memberId,
          b.timeframe,
          b.startAt,
          b.resetAt,
          b.policyId,
          b.policyName,
          b.policyRevision,
          b.baseAllowanceMicroUsd,
          b.hardLimit,
          b.allowRequestReset,
        ]),
    ])
  return signature(left) === signature(right)
}

export function snapshotAdmission(snapshot: GatewayUsageSnapshot, requestStartedAt: Date) {
  return snapshot.version === 2 ? new Date(snapshot.admittedAt) : requestStartedAt
}
