import { describe, expect, test } from "bun:test";
import type { GatewayUsageBucket, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import {
  allGatewayUsageBuckets,
  gatewayUsageCanSwitchProvider,
  gatewayUsageForProvider,
  gatewayUsageLimitGroups,
  gatewayUsageNoticeState,
  gatewayUsageResetDelay,
} from "../src/react-app/domains/cloud/gateway-usage-state";

function bucket(id: string, usedMicroUsd: number, resetAt = "2026-11-01T05:00:00.000Z"): GatewayUsageBucket {
  return {
    id, timeframe: "month", policyId: id, policyName: id, baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0,
    allowanceMicroUsd: 1_000_000, usedMicroUsd, remainingMicroUsd: 1_000_000 - usedMicroUsd, resetAt,
    hardLimit: true, allowRequestReset: true, canRequestReset: usedMicroUsd >= 1_000_000, resetRequestStatus: null,
  };
}

function status(input: { defaultUsed: number | null; providers?: { id: string; used: number }[] }): GatewayUsageStatus {
  return {
    serverTime: "2026-10-14T12:00:00.000Z",
    organizationId: "org",
    memberId: "member",
    state: input.defaultUsed === null ? "unlimited" : input.defaultUsed >= 1_000_000 ? "blocked" : "within_limit",
    coverage: { complete: true, unpricedRequests: 0 },
    buckets: input.defaultUsed === null ? [] : [bucket("default", input.defaultUsed)],
    providers: input.providers?.map((provider) => ({
      providerId: provider.id,
      providerName: `Provider ${provider.id}`,
      state: provider.used >= 1_000_000 ? "blocked" : "within_limit",
      buckets: [bucket(`bucket-${provider.id}`, provider.used, "2026-10-15T05:00:00.000Z")],
    })),
  };
}

describe("usage limit that governs the selected model", () => {
  test("a provider limit replaces the default for that provider", () => {
    const value = status({ defaultUsed: 1_000_000, providers: [{ id: "a", used: 0 }] });
    const forA = gatewayUsageForProvider(value, "a");
    expect(forA.providerName).toBe("Provider a");
    expect(forA.status.state).toBe("within_limit");
    // Out of default usage but provider A still has room: no notice on A.
    expect(gatewayUsageNoticeState({ gatewaySelected: true, status: forA.status })).toBeNull();
    // Provider B has no limit of its own, so the default (blocked) applies.
    const forB = gatewayUsageForProvider(value, "b");
    expect(forB.providerName).toBeNull();
    expect(gatewayUsageNoticeState({ gatewaySelected: true, status: forB.status })).toBe("blocked");
  });

  test("suggests switching only when another provider still has room", () => {
    const blockedOnA = status({ defaultUsed: 0, providers: [{ id: "a", used: 1_000_000 }] });
    expect(gatewayUsageCanSwitchProvider(blockedOnA, "a", ["a", "b"])).toBe(true);
    // No other Gateway provider to switch to.
    expect(gatewayUsageCanSwitchProvider(blockedOnA, "a", ["a"])).toBe(false);
    // Not blocked: nothing to suggest.
    expect(gatewayUsageCanSwitchProvider(blockedOnA, "b", ["a", "b"])).toBe(false);

    const blockedEverywhere = status({ defaultUsed: 1_000_000, providers: [{ id: "a", used: 1_000_000 }] });
    expect(gatewayUsageCanSwitchProvider(blockedEverywhere, "a", ["a", "b"])).toBe(false);

    const blockedOnDefault = status({ defaultUsed: 1_000_000, providers: [{ id: "a", used: 0 }] });
    expect(gatewayUsageCanSwitchProvider(blockedOnDefault, "b", ["a", "b", "c"])).toBe(true);
    expect(gatewayUsageCanSwitchProvider(blockedOnDefault, "b", ["b", "c"])).toBe(false);
  });

  test("refresh timing and buckets include provider limits", () => {
    const value = status({ defaultUsed: 0, providers: [{ id: "a", used: 0 }] });
    expect(allGatewayUsageBuckets(value).map((item) => item.id)).toEqual(["default", "bucket-a"]);
    const receivedAt = Date.parse(value.serverTime);
    // Provider A resets first (next day), so the refresh is scheduled for it.
    expect(gatewayUsageResetDelay(value, receivedAt, receivedAt)).toBe(17 * 60 * 60_000 + 250);
  });

  test("statuses without providers behave as before", () => {
    const value = status({ defaultUsed: 1_000_000 });
    expect(gatewayUsageForProvider(value, "a").status).toBe(value);
    expect(gatewayUsageCanSwitchProvider(value, "a", ["a", "b"])).toBe(false);
  });

  test("limit items: default when set, then one per provider limit", () => {
    const names = (value: GatewayUsageStatus) => gatewayUsageLimitGroups(value).map((group) => group.providerName ?? "Default");
    expect(names(status({ defaultUsed: 0 }))).toEqual(["Default"]);
    expect(names(status({ defaultUsed: 0, providers: [{ id: "a", used: 0 }, { id: "b", used: 0 }] }))).toEqual(["Default", "Provider a", "Provider b"]);
    // No default limit: only the provider limits are items.
    expect(names(status({ defaultUsed: null, providers: [{ id: "a", used: 0 }] }))).toEqual(["Provider a"]);
    expect(names(status({ defaultUsed: null }))).toEqual([]);
  });
});
