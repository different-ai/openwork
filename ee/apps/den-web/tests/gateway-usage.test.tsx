import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GatewayUsageResponse } from "@openwork/types/den/gateway-usage";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as requests from "../app/(den)/_lib/den-flow";
import { GatewayUsageSection } from "../app/(den)/dashboard/_components/gateway-usage-section";
import { GatewaySpendBreakdown } from "../app/(den)/dashboard/_components/gateway-spend-breakdown";
import { gatewayUsageModelFamily, gatewayUsageTotals } from "../app/(den)/dashboard/_components/gateway-usage-data";
import { assignSeriesColors } from "../app/(den)/dashboard/_features/analytics/series-colors";

test("assigns distinct colors beyond 24 categories and preserves them through filtering and reordering", () => {
  const ids = Array.from({ length: 60 }, (_, index) => `series-${index}`);
  const colors = assignSeriesColors(ids);
  expect(new Set(colors.values()).size).toBe(60);
  expect(assignSeriesColors([...ids].reverse())).toEqual(colors);
  expect(assignSeriesColors([ids[4]], colors)).toBe(colors);
  const extended = assignSeriesColors(["new-series", ...ids], colors);
  for (const id of ids) expect(extended.get(id)).toBe(colors.get(id));
});

function fixture(): GatewayUsageResponse {
  return { usage: {
    groupBy: "model", days: 31, from: "2026-01-01", to: "2026-01-31", timezone: "UTC",
    requestCount: 1000, totalTokens: 150, totalCostMicroUsd: 12345678901,
    unreportedRequests: 9, uncountableRequests: { ok: 1, upstream_error: 3, upstream_unreachable: 1, client_aborted: 2, rejected: 2 }, unpricedRequests: 9,
    series: [
      { id: "model-a", label: "Model A" },
      { id: "model-b", label: "Model B" },
      { id: "unknown-empty", label: "Unreported model (empty)" },
      { id: "unknown-used", label: "Unreported model (with usage)" },
    ],
    filterOptions: [],
    daily: Array.from({ length: 31 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      totalTokens: index === 30 ? 150 : 0,
      values: index === 30 ? { "model-a": 100, "model-b": 40, "unknown-empty": 0, "unknown-used": 10 } : {},
      totalCostMicroUsd: index === 30 ? 12345678901 : 0,
      costValues: index === 30 ? { "model-a": 12345678901, "model-b": 0, "unknown-empty": null, "unknown-used": null } : {},
    })),
  } };
}

async function renderUsage(payload: GatewayUsageResponse, check: (container: HTMLDivElement) => Promise<void> | void, node = <GatewayUsageSection orgId="org-fixture" />) {
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const request = spyOn(requests, "requestJson").mockResolvedValue({ response: Response.json(payload), payload, text: JSON.stringify(payload) });
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await check(container);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    request.mockRestore();
    container.remove();
    await GlobalRegistrator.unregister();
  }
}

test("omits empty token series, preserves real unknown usage and keeps colors across metrics", async () => {
  await renderUsage(fixture(), async (container) => {
    const legend = () => container.querySelector('[aria-label="Chart legend"]');
    expect(legend()?.textContent).not.toContain("Unreported model (empty)");
    expect(legend()?.textContent).toContain("Unreported model (with usage)");
    expect(container.textContent).toContain("The data does not include uncountable queries");
    expect(container.textContent).not.toContain("did not report token usage");
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(container.querySelector('a[href="https://openworklabs.com/docs/ai-gateway/counting-usage#uncountable-items"]')).not.toBeNull();
    await act(async () => details?.querySelector("summary")?.click());
    expect(details?.open).toBe(true);
    const counts = [...(details?.querySelectorAll("dl > div") ?? [])].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
    expect(counts).toEqual([["Provider errors", "3"], ["Connection failures", "1"], ["Cancellations and interruptions", "2"], ["Rejected requests", "2"], ["Completed without reported usage", "1"]]);
    const color = () => legend()?.querySelector("li span")?.getAttribute("style");
    const tokenColor = color();
    const cost = [...container.querySelectorAll("button")].find((button) => button.textContent === "Cost");
    expect(cost).toBeDefined();
    await act(async () => cost?.click());
    expect(color()).toBe(tokenColor);
    const costNote = container.querySelector('[role="note"]');
    expect(costNote?.textContent).toBe("Costs are approximate based on publicly listed model prices when each request was recorded. Click here to see how costs are calculated");
    expect(costNote?.querySelector("a")?.getAttribute("href")).toBe("https://openworklabs.com/docs/ai-gateway/token-costs");
    expect(container.textContent).toContain("$12,345.68");
    expect(container.textContent).toContain("$6,172.84");
    expect(container.textContent).not.toContain("$12,345.678901");
    expect(container.querySelector('[aria-label="2026-01-31 UTC: $12,345.68 cost · usd"]')).not.toBeNull();
    expect(legend()?.textContent).toContain("Model B"); // Observed zero cost is still known.
    expect(legend()?.textContent).not.toContain("Unreported model");
  });
});

test("accepts an older API without requestCount and rejects impossible coverage", async () => {
  const older = fixture();
  delete older.usage.requestCount;
  delete older.usage.uncountableRequests;
  await renderUsage(older, (container) => {
    expect(container.textContent).toContain("9 uncountable queries in this period");
  });
  const invalid = fixture();
  invalid.usage.requestCount = 1;
  await renderUsage(invalid, (container) => {
    expect(container.textContent).toContain("inconsistent daily totals");
  });
});


test("hides the note when all queries are countable and preserves unknown historical categories", async () => {
  const complete = fixture();
  complete.usage.unreportedRequests = 0;
  complete.usage.uncountableRequests = { ok: 0, upstream_error: 0, upstream_unreachable: 0, client_aborted: 0, rejected: 0 };
  await renderUsage(complete, (container) => {
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("uncountable queries");
  });
  const historical = fixture();
  historical.usage.uncountableRequests = { ok: null, upstream_error: null, upstream_unreachable: null, client_aborted: 0, rejected: null };
  await renderUsage(historical, (container) => {
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Some older records do not retain a breakdown");
  });
  const invalid = fixture();
  invalid.usage.uncountableRequests = { ok: 10, upstream_error: 0, upstream_unreachable: 0, client_aborted: 0, rejected: 0 };
  await renderUsage(invalid, (container) => expect(container.textContent).toContain("inconsistent daily totals"));
});

test("totals rank series by estimated cost, keep unknown cost distinct and decode model families", () => {
  const totals = gatewayUsageTotals(fixture().usage);
  expect(totals.map((row) => row.id)).toEqual(["model-a", "model-b", "unknown-used"]);
  expect(totals[0]).toMatchObject({ costMicroUsd: 12345678901, tokens: 100, unpriced: false });
  expect(totals[2]).toMatchObject({ costMicroUsd: 0, tokens: 10, unpriced: true });
  expect(gatewayUsageModelFamily("model:616E7468726F706963:636C61756465")).toBe("anthropic");
  expect(gatewayUsageModelFamily("member_123")).toBeNull();
  expect(gatewayUsageModelFamily("model:ZZ:00")).toBeNull();
});

test("spend breakdown lists who spends it with person links and models by share of spend", async () => {
  const people = fixture();
  people.usage.groupBy = "person";
  await renderUsage(people, (container) => {
    const peopleCard = container.querySelector('[data-testid="gateway-spend-people"]');
    const rows = peopleCard?.querySelectorAll('[data-testid="gateway-spend-people-row"]') ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Model A");
    expect(rows[0]?.textContent).toContain("100% of spend");
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/dashboard/ai-gateway/people/model-a");
    expect(rows[2]?.textContent).toContain("Unknown");
    expect(container.querySelector('[data-testid="gateway-spend-models"]')?.textContent).toContain("Models people use");
  }, <GatewaySpendBreakdown orgId="org-fixture" orgSlug={null} />);
});
