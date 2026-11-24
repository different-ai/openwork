import { readFile } from "node:fs/promises";
import { createDenTypeId } from "@openwork-ee/utils/typeid";
import { describe, expect, test } from "bun:test";
import {
  GATEWAY_DEFAULT_USAGE_SCOPE,
  gatewayRequestScope,
  gatewayUsageLimitResponse,
  gatewayWinningPoliciesByScope,
  type GatewayUsageBucket,
  type GatewayUsageLimitPolicy,
} from "@openwork/types/den/gateway-usage-limits";
import { projectedBucket, usageSnapshot, type GatewayUsageScope } from "../src/gateway-usage-read";
import { sameUsageSnapshot, snapshotScope, validateUsageSnapshot } from "../src/gateway-usage-snapshot";

const providerA = createDenTypeId("inferenceProvider");
const providerB = createDenTypeId("inferenceProvider");

function policy(id: string, providerId: string | null, limits: GatewayUsageLimitPolicy["limits"]): GatewayUsageLimitPolicy {
  return { id, name: id, hardLimit: true, allowRequestReset: true, revision: 1, providerId, limits, assignments: [] };
}

const scope: GatewayUsageScope = {
  organizationId: createDenTypeId("organization"),
  memberId: createDenTypeId("member"),
};

describe("winners per provider scope", () => {
  test("provider limits never mix with the default limits", () => {
    const winners = gatewayWinningPoliciesByScope([
      policy("default-month", null, [{ timeframe: "month", costLimitMicroUsd: 100_000_000 }, { timeframe: "day", costLimitMicroUsd: 5_000_000 }]),
      policy("a-small", providerA, [{ timeframe: "month", costLimitMicroUsd: 10_000_000 }]),
      policy("a-large", providerA, [{ timeframe: "month", costLimitMicroUsd: 50_000_000 }]),
      policy("b-week", providerB, [{ timeframe: "week", costLimitMicroUsd: 20_000_000 }]),
    ]);
    expect([...winners.keys()].sort()).toEqual([GATEWAY_DEFAULT_USAGE_SCOPE, providerA, providerB].sort());
    expect(winners.get(GATEWAY_DEFAULT_USAGE_SCOPE)?.map((winner) => [winner.limit.timeframe, winner.policy.id]))
      .toEqual([["day", "default-month"], ["month", "default-month"]]);
    // Highest allowance per timeframe wins inside one provider scope.
    expect(winners.get(providerA)?.map((winner) => [winner.limit.timeframe, winner.policy.id])).toEqual([["month", "a-large"]]);
    // Provider B has no daily cap even though the default has one.
    expect(winners.get(providerB)?.map((winner) => winner.limit.timeframe)).toEqual(["week"]);
  });

  test("archived provider limits do not create a scope", () => {
    const archived = { ...policy("a", providerA, [{ timeframe: "month", costLimitMicroUsd: 1 }]), archivedAt: new Date(0).toISOString() };
    expect(gatewayWinningPoliciesByScope([archived]).has(providerA)).toBe(false);
  });

  test("a request uses its provider's scope only when the member has a limit for it", () => {
    const scopes = new Set([GATEWAY_DEFAULT_USAGE_SCOPE, providerA]);
    expect(gatewayRequestScope(scopes, providerA)).toBe(providerA);
    expect(gatewayRequestScope(scopes, providerB)).toBe(GATEWAY_DEFAULT_USAGE_SCOPE);
    expect(gatewayRequestScope(scopes, null)).toBe(GATEWAY_DEFAULT_USAGE_SCOPE);
    expect(gatewayRequestScope(new Set<string>(), providerA)).toBe(GATEWAY_DEFAULT_USAGE_SCOPE);
  });
});

describe("provider buckets and admission snapshots", () => {
  const now = new Date("2026-10-14T12:00:00.000Z");

  test("default bucket ids keep their shape; provider buckets get their own ids", () => {
    const fallback = projectedBucket(scope, "month", now);
    const scoped = projectedBucket(scope, "month", now, providerA);
    expect(fallback.providerScope).toBe("");
    expect(scoped.providerScope).toBe(providerA);
    expect(scoped.id).not.toBe(fallback.id);
    expect(projectedBucket(scope, "month", now, providerB).id).not.toBe(scoped.id);
  });

  test("default snapshots carry no provider field, provider snapshots round-trip", () => {
    const fallback = usageSnapshot((["day", "week", "month"] as const).map((frame) => projectedBucket(scope, frame, now)), now);
    expect(fallback.buckets.every((bucket) => !("providerScope" in bucket))).toBe(true);
    expect(snapshotScope(validateUsageSnapshot(fallback, scope, now))).toBe("");

    const scoped = usageSnapshot((["day", "week", "month"] as const).map((frame) => projectedBucket(scope, frame, now, providerA)), now);
    const validated = validateUsageSnapshot(JSON.parse(JSON.stringify(scoped)), scope, now);
    expect(snapshotScope(validated)).toBe(providerA);
    expect(sameUsageSnapshot(validated, scoped)).toBe(true);
    expect(sameUsageSnapshot(validated, fallback)).toBe(false);
  });

  test("a snapshot cannot mix scopes", () => {
    const buckets = [
      projectedBucket(scope, "day", now, providerA),
      projectedBucket(scope, "week", now),
      projectedBucket(scope, "month", now, providerA),
    ];
    expect(() => validateUsageSnapshot(usageSnapshot(buckets, now), scope, now)).toThrow();
  });
});

describe("out-of-usage response", () => {
  const bucket: GatewayUsageBucket = {
    id: "bucket", timeframe: "month", policyId: "p", policyName: "p", baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0,
    allowanceMicroUsd: 1_000_000, usedMicroUsd: 1_000_000, remainingMicroUsd: 0, resetAt: "2026-11-01T05:00:00.000Z",
    hardLimit: true, allowRequestReset: true, canRequestReset: true, resetRequestStatus: null,
  };

  test("names the provider whose limit ran out", async () => {
    const response = gatewayUsageLimitResponse({ buckets: [bucket], serverTime: "2026-10-14T12:00:00.000Z" }, { id: providerA, name: "Provider A" });
    expect(response?.status).toBe(429);
    const body = await response?.json();
    expect(body.error.details.provider).toEqual({ id: providerA, name: "Provider A" });
    expect(body.error.message).toContain("Provider A");
  });

  test("keeps the default response unchanged", async () => {
    const body = await gatewayUsageLimitResponse({ buckets: [bucket], serverTime: "2026-10-14T12:00:00.000Z" })?.json();
    expect(body.error.details.provider).toBeUndefined();
    expect(body.error.message).toBe("You have reached your AI Gateway usage limit.");
  });
});

describe("migration 0146", () => {
  test("adds columns without dropping data", async () => {
    const sql = await readFile(new URL("../drizzle/0146_gateway_provider_usage_limits.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN/i);
    // The new unique window exists before the old one is dropped.
    expect(sql.indexOf("gateway_usage_bucket_scope_window")).toBeLessThan(sql.indexOf("DROP INDEX `gateway_usage_bucket_window`"));
    expect(sql).toContain("DEFAULT '' NOT NULL");
  });
});
