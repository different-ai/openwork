import { expect, test } from "bun:test";
import type { GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { createGatewayUsageSettlementRefresh, gatewayUsageNeedsSettlement, gatewayUsageSettlementDelays } from "../src/react-app/domains/cloud/gateway-usage-refresh";
import { trackedCoverage } from "./gateway-usage-fixture";

function harness(coverage?: GatewayUsageStatus["coverage"]) {
  let reads = 0;
  let unresolved = true;
  let current = true;
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const runner = createGatewayUsageSettlementRefresh({
    refresh: async () => { reads++; },
    hasUnresolved: () => coverage ? gatewayUsageNeedsSettlement(coverage) : unresolved,
    isCurrent: () => current,
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return {
    runner, timers, reads: () => reads,
    coverage: (next: GatewayUsageStatus["coverage"]) => { coverage = next; },
    resolved: () => { unresolved = false; },
    changedScope: () => { current = false; runner.dispose(); },
    async advance() {
      const timer = timers.find((item) => !item.cancelled);
      if (!timer) throw new Error("No pending timer");
      timer.cancelled = true;
      timer.callback();
      await Promise.resolve();
    },
  };
}

test("historical uncertainty and unresolved costs do not retry settled writes", async () => {
  const coverage = trackedCoverage({ unpricedRequests: 2, incompleteRequests: 3, quarantinedRequests: 1 });
  const h = harness(coverage);
  h.runner.complete("settled-turn");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
  expect(h.timers).toHaveLength(0);
  expect(coverage).toMatchObject({ complete: false, unpricedRequests: 2, incompleteRequests: 3 });
  h.runner.dispose();
});

test("pending writes continue until settlementReady without waiting for historical completeness", async () => {
  const h = harness(trackedCoverage({ pendingRequests: 1, settlementReady: false }));
  h.runner.complete("pending-turn");
  await Promise.resolve();
  await h.advance();
  expect(h.reads()).toBe(2);
  h.coverage(trackedCoverage({ incompleteRequests: 1 }));
  await h.advance();
  expect(h.reads()).toBe(3);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.dispose();
});

test("missing tracking is not interpreted as zero pending requests", async () => {
  const h = harness(trackedCoverage({ historicalUnknownReason: "tracking_not_started", trackingStartedAt: null, pendingRequests: null, settlementReady: false, lastSettlementAt: null, lastSettlementRequestId: null }));
  h.runner.complete("first-turn");
  await Promise.resolve();
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
  h.coverage(trackedCoverage());
  await h.advance();
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.dispose();
});

test.each([
  { complete: true, unpricedRequests: 0 },
  { complete: false, unpricedRequests: 0 },
  { complete: true, unpricedRequests: 2 },
  { complete: false, unpricedRequests: 0, quarantinedRequests: 1 },
])("old servers fall back to accounting coverage: %j", async (coverage) => {
  const h = harness(coverage);
  h.runner.complete("legacy-turn");
  await Promise.resolve();
  const unresolved = !coverage.complete || coverage.unpricedRequests > 0;
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(unresolved ? 1 : 0);
  h.runner.dispose();
});

test("settlementReady false wins even if legacy complete is true", () => {
  expect(gatewayUsageNeedsSettlement({ complete: true, unpricedRequests: 0, pendingRequests: 1, settlementReady: false })).toBe(true);
});

test("permanent historical unknown costs stop at the finite backoff cap and stable keys cannot restart it", async () => {
  const h = harness();
  h.runner.complete("turn-a");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
  for (const delay of gatewayUsageSettlementDelays) {
    expect(h.timers.find((timer) => !timer.cancelled)?.delay).toBe(delay);
    h.runner.complete("turn-a");
    await h.advance();
  }
  expect(h.reads()).toBe(5);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.complete("turn-a");
  await Promise.resolve();
  expect(h.reads()).toBe(5);
  h.runner.dispose();
});

test("coalesces concurrent pane completion signals and stops once accounting resolves", async () => {
  const h = harness();
  h.runner.complete("pane-a");
  h.runner.complete("pane-b");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
  await h.advance();
  expect(h.reads()).toBe(2);
  h.resolved();
  await h.advance();
  expect(h.reads()).toBe(3);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.complete("pane-b");
  await Promise.resolve();
  expect(h.reads()).toBe(3);
  h.runner.dispose();
});

test("a distinct completion refreshes immediately during backoff and gets a fresh finite budget", async () => {
  const h = harness();
  h.runner.complete("turn-a");
  await Promise.resolve();
  await h.advance();
  h.runner.complete("turn-b");
  await Promise.resolve();
  expect(h.reads()).toBe(3);
  for (const delay of gatewayUsageSettlementDelays) {
    expect(h.timers.find((timer) => !timer.cancelled)?.delay).toBe(delay);
    h.runner.complete("turn-b");
    await h.advance();
  }
  expect(h.reads()).toBe(7);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.dispose();
});

test("scope change cancels queued callbacks and does not refresh a replacement account", async () => {
  const h = harness();
  h.runner.complete("old-turn");
  await Promise.resolve();
  h.changedScope();
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.timers[0].callback();
  h.runner.complete("new-turn");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
});
