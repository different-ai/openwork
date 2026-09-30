import { afterEach, expect, test } from "bun:test";
import { createDenClient, DenApiError } from "../src/app/lib/den";
import { trackedCoverage, usageStatus } from "./gateway-usage-fixture";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const calls: { url: string; init?: RequestInit }[] = [];
function respond(payload: unknown, status = 200) {
  calls.length = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json(payload, { status });
  } });
}
const client = () => createDenClient({ baseUrl: "https://den.test", token: "test-member-token" });

test("reads plain JSON using the member transport and explicit organization headers", async () => {
  respond(usageStatus());
  expect(await client().getGatewayUsageStatus("org_test")).toEqual(usageStatus());
  expect(calls[0].url).toEndWith("/v1/gateway/usage-limits/me");
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.get("authorization")).toBe("Bearer test-member-token");
  expect(headers.get("x-openwork-org-id")).toBe("org_test");
  expect(headers.get("x-openwork-legacy-org-id")).toBe("org_test");
  expect(calls[0].init?.credentials).toBe("include");
  expect(calls[0].init?.body).toBeUndefined();
});

test("preserves optional settlement and historical fields without inferring complete coverage", async () => {
  for (const coverage of [trackedCoverage(), trackedCoverage({ historicalUnknownReason: "tracking_not_started", trackingStartedAt: null, pendingRequests: null, settlementReady: false, lastSettlementAt: null, lastSettlementRequestId: null })]) {
    respond(usageStatus({ coverage }));
    expect((await client().getGatewayUsageStatus("org_test")).coverage).toEqual(coverage);
  }
});

test("rejects absent sign-in, wrong organization and malformed envelopes", async () => {
  respond(usageStatus());
  await expect(createDenClient({ baseUrl: "https://den.test" }).getGatewayUsageStatus("org_test")).rejects.toThrow("Sign in");
  expect(calls).toHaveLength(0);
  await expect(client().getGatewayUsageStatus("org_other")).rejects.toThrow("different organization");
  respond({ data: usageStatus() });
  await expect(client().getGatewayUsageStatus("org_test")).rejects.toThrow();
});

test("requires a bounded reason and posts only bucketId and trimmed reason", async () => {
  respond({ id: "request_test", memberId: "member_test", memberName: "Test", memberEmail: "test@example.test", bucketId: "bucket_test", timeframe: "day", policyName: "Standard", reason: "Finish task", status: "pending", createdAt: "2026-09-15T12:00:00.000Z", reviewedAt: null, reviewedBy: null, baseAllowanceMicroUsd: 1_000_000, allowanceMicroUsd: 1_000_000, usedMicroUsd: 1_300_000, resetAt: "2026-09-16T05:00:00.000Z" });
  for (const reason of ["  ", "x".repeat(2001)]) await expect(client().requestGatewayUsageReset("org_test", { bucketId: "bucket_test", reason })).rejects.toThrow();
  expect(calls).toHaveLength(0);
  const pending = await client().requestGatewayUsageReset("org_test", { bucketId: "bucket_test", reason: " Finish task " });
  expect(pending.status).toBe("pending");
  expect(pending.allowanceMicroUsd).toBe(pending.baseAllowanceMicroUsd);
  expect(pending.allowanceMicroUsd).toBe(1_000_000);
  expect(pending.usedMicroUsd).toBe(1_300_000);
  expect(calls[0].url).toEndWith("/v1/gateway/usage-limit-reset-requests");
  expect(calls[0].init?.method).toBe("POST");
  expect(calls[0].init?.body).toBe(JSON.stringify({ bucketId: "bucket_test", reason: "Finish task" }));
  expect(new Headers(calls[0].init?.headers).get("x-openwork-org-id")).toBe("org_test");
});

test.each([401, 403, 409, 503])("does not turn HTTP %s into unlimited usage", async (status) => {
  respond({ error: "gateway_usage_unavailable", message: "Unavailable" }, status);
  await expect(client().getGatewayUsageStatus("org_test")).rejects.toBeInstanceOf(DenApiError);
  expect(calls).toHaveLength(1);
});
