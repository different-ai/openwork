import { z } from "zod"

export const gatewayUsageTimeframeSchema = z.enum(["day", "week", "month"])
export type GatewayUsageTimeframe = z.infer<typeof gatewayUsageTimeframeSchema>
export const gatewayUsageTimeframes: GatewayUsageTimeframe[] = ["day", "week", "month"]
export const MAX_GATEWAY_ALLOWANCE_MICRO_USD = 7_205_759_403_792_792

export function gatewayUsdToMicroUsd(value: string): number {
  if (value.length > 32 || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error("Enter a nonnegative USD decimal with at most six fractional digits.")
  const [whole, fraction = ""] = value.split(".")
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))
  if (amount > BigInt(MAX_GATEWAY_ALLOWANCE_MICRO_USD))
    throw new Error("Allowance exceeds the supported range.")
  return Number(amount)
}

export function gatewaySafeMoney(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Gateway accounting exceeds the safe integer range.")
  return value
}

export function gatewayUsagePeriod(
  timeframe: GatewayUsageTimeframe,
  now: Date,
): { start: Date; end: Date } {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid admission time.")
  const shifted = new Date(now.getTime() - 5 * 3_600_000)
  const start = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 5),
  )
  if (timeframe === "week") start.setUTCDate(start.getUTCDate() - ((shifted.getUTCDay() + 6) % 7))
  if (timeframe === "month") start.setUTCDate(1)
  const end = new Date(start)
  if (timeframe === "month") end.setUTCMonth(end.getUTCMonth() + 1)
  else end.setUTCDate(end.getUTCDate() + (timeframe === "week" ? 7 : 1))
  return { start, end }
}

export const gatewayUsagePolicyWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    hardLimit: z.boolean().default(true),
    allowRequestReset: z.boolean().default(true),
    limits: z
      .array(
        z
          .object({
            timeframe: gatewayUsageTimeframeSchema,
            costUsd: z
              .string()
              .max(32)
              .superRefine((value, ctx) => {
                try {
                  gatewayUsdToMicroUsd(value)
                } catch {
                  ctx.addIssue({
                    code: "custom",
                    message: "Invalid USD allowance (maximum six decimal places).",
                  })
                }
              }),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .refine(
        (limits) => new Set(limits.map((limit) => limit.timeframe)).size === limits.length,
        "Timeframes must be unique.",
      ),
  })
  .strict()
export type GatewayUsagePolicyWrite = z.infer<typeof gatewayUsagePolicyWriteSchema>
export type GatewayUsageLimitPolicy = {
  id: string
  name: string
  hardLimit: boolean
  allowRequestReset: boolean
  revision: number
  limits: { timeframe: GatewayUsageTimeframe; costLimitMicroUsd: number }[]
  assignments: { id: string; memberId: string | null; teamId: string | null; organization: boolean }[]
  archivedAt?: string | null
}
export type GatewayUsageResetStatus = "pending" | "approved" | "denied" | "expired"
export const gatewayUsageProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization"),
      assignmentId: z.string(),
      memberId: z.null(),
      teamId: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("direct"),
      assignmentId: z.string(),
      memberId: z.string(),
      teamId: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("team"),
      assignmentId: z.string(),
      memberId: z.null(),
      teamId: z.string(),
      teamName: z.string(),
    })
    .strict(),
])
export type GatewayUsageProvenance = z.infer<typeof gatewayUsageProvenanceSchema>
export type GatewayUsageBucket = {
  policyRevision?: number
  provenance?: GatewayUsageProvenance[]
  id: string
  timeframe: GatewayUsageTimeframe
  policyId: string
  policyName: string
  baseAllowanceMicroUsd: number
  extensionMicroUsd: number
  allowanceMicroUsd: number
  usedMicroUsd: number
  remainingMicroUsd: number
  resetAt: string
  hardLimit: boolean
  allowRequestReset: boolean
  canRequestReset: boolean
  resetRequestStatus: GatewayUsageResetStatus | null
}
export type GatewayUsageStatus = {
  serverTime: string
  organizationId: string
  memberId: string
  state: "unlimited" | "within_limit" | "over_limit" | "blocked"
  coverage: {
    complete: boolean
    unpricedRequests: number
    quarantinedRequests?: number
    historicalCoverage?: "unknown" | "tracked_since_epoch"
    historicalUnknownReason?:
      | "tracking_not_started"
      | "period_predates_tracking"
      | "legacy_counter"
      | null
    trackingStartedAt?: string | null
    trackingVersion?: number
    captureEnabled?: boolean
    pendingRequests?: number | null
    incompleteRequests?: number
    lastSettlementAt?: string | null
    lastSettlementRequestId?: string | null
    settlementReady?: boolean
  }
  buckets: GatewayUsageBucket[]
}
export type GatewayUsageResetRequest = {
  id: string
  memberId: string
  memberName: string
  memberEmail: string
  bucketId: string
  timeframe: GatewayUsageTimeframe
  policyName: string
  reason: string
  status: GatewayUsageResetStatus
  createdAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  baseAllowanceMicroUsd: number
  allowanceMicroUsd: number
  usedMicroUsd: number
  resetAt: string
}
const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const gatewayUsageLimitPolicySchema: z.ZodType<GatewayUsageLimitPolicy> = z.object({
  id: z.string(),
  name: z.string(),
  hardLimit: z.boolean(),
  allowRequestReset: z.boolean(),
  revision: z.number().int(),
  limits: z.array(
    z.object({ timeframe: gatewayUsageTimeframeSchema, costLimitMicroUsd: moneySchema }),
  ),
  assignments: z.array(
    z.object({
      id: z.string(),
      memberId: z.string().nullable(),
      teamId: z.string().nullable(),
      organization: z.boolean().default(false),
    }),
  ),
  archivedAt: z.iso.datetime().nullable().optional(),
})
export const gatewayUsageStatusSchema: z.ZodType<GatewayUsageStatus> = z.object({
  serverTime: z.iso.datetime(),
  organizationId: z.string(),
  memberId: z.string(),
  state: z.enum(["unlimited", "within_limit", "over_limit", "blocked"]),
  coverage: z.object({
    complete: z.boolean(),
    unpricedRequests: moneySchema,
    quarantinedRequests: moneySchema.optional(),
    historicalCoverage: z.enum(["unknown", "tracked_since_epoch"]).optional(),
    historicalUnknownReason: z
      .enum(["tracking_not_started", "period_predates_tracking", "legacy_counter"])
      .nullable()
      .optional(),
    trackingStartedAt: z.iso.datetime().nullable().optional(),
    trackingVersion: z.number().int().min(0).max(2147483647).optional(),
    captureEnabled: z.boolean().optional(),
    pendingRequests: moneySchema.nullable().optional(),
    incompleteRequests: moneySchema.optional(),
    lastSettlementAt: z.iso.datetime().nullable().optional(),
    lastSettlementRequestId: z.string().nullable().optional(),
    settlementReady: z.boolean().optional(),
  }),
  buckets: z.array(
    z.object({
      id: z.string(),
      timeframe: gatewayUsageTimeframeSchema,
      policyId: z.string(),
      policyName: z.string(),
      policyRevision: z.number().int().positive().optional(),
      provenance: z.array(gatewayUsageProvenanceSchema).optional(),
      baseAllowanceMicroUsd: moneySchema,
      extensionMicroUsd: moneySchema,
      allowanceMicroUsd: moneySchema,
      usedMicroUsd: moneySchema,
      remainingMicroUsd: z
        .number()
        .int()
        .min(-Number.MAX_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      resetAt: z.iso.datetime(),
      hardLimit: z.boolean(),
      allowRequestReset: z.boolean(),
      canRequestReset: z.boolean(),
      resetRequestStatus: z.enum(["pending", "approved", "denied", "expired"]).nullable(),
    }),
  ),
})
export const gatewayUsageResetRequestSchema: z.ZodType<GatewayUsageResetRequest> = z.object({
  id: z.string(),
  memberId: z.string(),
  memberName: z.string(),
  memberEmail: z.string(),
  bucketId: z.string(),
  timeframe: gatewayUsageTimeframeSchema,
  policyName: z.string(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  createdAt: z.iso.datetime(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  baseAllowanceMicroUsd: moneySchema,
  allowanceMicroUsd: moneySchema,
  usedMicroUsd: moneySchema,
  resetAt: z.iso.datetime(),
})
export const gatewayUsageResetCursorSchema = z
  .object({
    organizationId: z.string(),
    memberId: z.string().nullable(),
    view: z.enum(["pending", "history"]),
    createdAt: z.iso.datetime(),
    id: z.string().min(1).max(64),
  })
  .strict()
export const gatewayUsageResetListOptionsSchema = z
  .object({
    view: z.enum(["pending", "history"]).default("pending"),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict()
export type GatewayUsageResetListOptions = z.input<typeof gatewayUsageResetListOptionsSchema>
export const gatewayUsageResetPageSchema = z.object({
  requests: z.array(gatewayUsageResetRequestSchema),
  view: z.enum(["pending", "history"]),
  limit: z.number().int().min(1).max(100),
  pendingCount: moneySchema,
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})
export type GatewayUsageResetPage = z.infer<typeof gatewayUsageResetPageSchema>

export function gatewayWinningPolicies(policies: GatewayUsageLimitPolicy[]) {
  return gatewayUsageTimeframes.flatMap((timeframe) => {
    const candidates = policies
      .filter((policy) => !policy.archivedAt)
      .flatMap((policy) =>
        policy.limits
          .filter((limit) => limit.timeframe === timeframe)
          .map((limit) => ({ policy, limit })),
      )
    candidates.sort(
      (a, b) =>
        b.limit.costLimitMicroUsd - a.limit.costLimitMicroUsd ||
        Number(b.policy.hardLimit) - Number(a.policy.hardLimit) ||
        Number(b.policy.allowRequestReset) - Number(a.policy.allowRequestReset) ||
        (a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0),
    )
    return candidates.slice(0, 1)
  })
}
export const GATEWAY_USAGE_LIMIT_ERROR_CODE = "openwork_gateway_usage_limit_exceeded"
export const GATEWAY_USAGE_ACCOUNTING_ERROR_CODE = "openwork_gateway_accounting_unavailable"
export function hasGatewayUsageLimitHttpMarker(
  response: Pick<Response, "status" | "headers">,
): boolean {
  return (
    response.status === 429 &&
    response.headers.get("X-OpenWork-Error-Code") === GATEWAY_USAGE_LIMIT_ERROR_CODE &&
    response.headers.get("X-OpenWork-Usage-State") === "blocked"
  )
}

export function gatewayUsageLimitResponse(status: GatewayUsageStatus): Response | null {
  const exhaustedBuckets = status.buckets
    .filter((bucket) => bucket.hardLimit && bucket.usedMicroUsd >= bucket.allowanceMicroUsd)
    .map((bucket) => ({
      bucketId: bucket.id,
      timeframe: bucket.timeframe,
      usedMicroUsd: bucket.usedMicroUsd,
      allowanceMicroUsd: bucket.allowanceMicroUsd,
      resetAt: bucket.resetAt,
      hardLimit: bucket.hardLimit,
      allowRequestReset: bucket.allowRequestReset,
    }))
  if (!exhaustedBuckets.length) return null
  const retryAt = new Date(
    Math.max(...exhaustedBuckets.map((bucket) => Date.parse(bucket.resetAt))),
  ).toISOString()
  return Response.json(
    {
      error: {
        type: "usage_limit_error",
        code: GATEWAY_USAGE_LIMIT_ERROR_CODE,
        source: "openwork_gateway",
        message: "You have reached your AI Gateway usage limit.",
        details: { exhaustedBuckets, retryAt },
      },
    },
    {
      status: 429,
      headers: {
        "X-OpenWork-Error-Code": GATEWAY_USAGE_LIMIT_ERROR_CODE,
        "X-OpenWork-Usage-State": "blocked",
        "Retry-After": String(
          Math.max(1, Math.ceil((Date.parse(retryAt) - Date.parse(status.serverTime)) / 1000)),
        ),
      },
    },
  )
}
export function gatewayAccountingUnavailableResponse(): Response {
  return Response.json(
    {
      error: {
        type: "accounting_unavailable_error",
        code: GATEWAY_USAGE_ACCOUNTING_ERROR_CODE,
        source: "openwork_gateway",
        message: "Gateway estimated-cost accounting is unavailable for this request.",
      },
    },
    { status: 503, headers: { "X-OpenWork-Error-Code": GATEWAY_USAGE_ACCOUNTING_ERROR_CODE } },
  )
}
