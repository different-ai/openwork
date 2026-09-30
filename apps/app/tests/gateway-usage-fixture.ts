import type { GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";

export function usageStatus(overrides: Partial<GatewayUsageStatus> = {}): GatewayUsageStatus {
  return {
    serverTime: "2026-09-15T12:00:00.000Z", organizationId: "org_test", memberId: "member_test",
    state: "blocked", coverage: { complete: false, unpricedRequests: 0 },
    buckets: [{
      id: "bucket_test", timeframe: "day", policyId: "policy_test", policyName: "Standard",
      baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0, allowanceMicroUsd: 1_000_000,
      usedMicroUsd: 1_300_000, remainingMicroUsd: -300_000, resetAt: "2026-09-16T05:00:00.000Z",
      hardLimit: true, allowRequestReset: true, canRequestReset: true, resetRequestStatus: null,
    }],
    ...overrides,
  };
}

export function trackedCoverage(overrides: Partial<GatewayUsageStatus["coverage"]> = {}): GatewayUsageStatus["coverage"] {
  return {
    complete: false, unpricedRequests: 0, incompleteRequests: 0,
    historicalCoverage: "unknown", historicalUnknownReason: "period_predates_tracking",
    trackingStartedAt: "2026-09-15T12:00:00.000Z", pendingRequests: 0, settlementReady: true,
    lastSettlementAt: "2026-09-15T12:01:00.000Z", lastSettlementRequestId: "request_settled",
    ...overrides,
  };
}

export function approvedUsageStatus(): GatewayUsageStatus {
  const status = usageStatus();
  return {
    ...status,
    buckets: status.buckets.map((bucket) => ({
      ...bucket,
      extensionMicroUsd: 250_000,
      allowanceMicroUsd: 1_250_000,
      remainingMicroUsd: -50_000,
      canRequestReset: true,
      resetRequestStatus: "approved",
    })),
  };
}
