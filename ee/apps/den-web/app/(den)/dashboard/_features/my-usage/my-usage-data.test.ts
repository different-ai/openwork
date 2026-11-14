import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateGatewayTokenMixCost,
  gatewayMemberUsageMetrics,
  gatewayMemberUsageResponseSchema,
  gatewayModelCostComparison,
  readGatewayListedPrice,
  type GatewayMemberUsageResponse,
} from "@openwork/types/den/gateway-member-usage";
import { getOrgAccessFlags, type DenOrgCapabilities } from "../../../_lib/den-org";
import { buildDashboardNavSections } from "../../_lib/dashboard-navigation";

/** `model:<hex provider>:<hex model>`, as Den reports usage series. */
function seriesId(provider: string, model: string): string {
  const hex = (value: string) => Buffer.from(value).toString("hex").toUpperCase();
  return `model:${hex(provider)}:${hex(model)}`;
}

const SONNET = seriesId("anthropic", "claude-sonnet-5");
const LUNA = seriesId("openai", "gpt-6-luna");

function day(date: string, values: Record<string, [tokens: number, cost: number | null]>) {
  return {
    date,
    totalTokens: Object.values(values).reduce((sum, [tokens]) => sum + tokens, 0),
    totalCostMicroUsd: Object.values(values).reduce((sum, [, cost]) => sum + (cost ?? 0), 0),
    values: Object.fromEntries(Object.entries(values).map(([id, [tokens]]) => [id, tokens])),
    costValues: Object.fromEntries(Object.entries(values).map(([id, [, cost]]) => [id, cost])),
  };
}

/** Three days of one member's usage: mostly Sonnet, a little Luna, one request without a price. */
const fixture: GatewayMemberUsageResponse = gatewayMemberUsageResponseSchema.parse({
  usage: {
    groupBy: "model", days: 3, from: "2026-11-11", to: "2026-11-13", timezone: "UTC",
    requestCount: 12,
    uncountableRequests: { ok: 1, upstream_error: 0, upstream_unreachable: 0, client_aborted: 0, rejected: 0 },
    totalTokens: 1_500_000 + 300_000 + 200_000,
    unreportedRequests: 1,
    totalCostMicroUsd: 4_500_000 + 2_000_000 + 600_000,
    unpricedRequests: 1,
    series: [{ id: SONNET, label: "Claude Sonnet 5" }, { id: LUNA, label: "GPT-6 Luna" }],
    daily: [
      day("2026-11-11", { [SONNET]: [1_500_000, 4_500_000] }),
      day("2026-11-12", { [SONNET]: [300_000, 2_000_000], [LUNA]: [100_000, null] }),
      day("2026-11-13", { [LUNA]: [100_000, 600_000] }),
    ],
    filterOptions: [],
  },
  tokenMix: [
    { seriesId: SONNET, measuredRequests: 8, uncachedInputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 600_000, cacheWriteTokens: 0 },
    { seriesId: LUNA, measuredRequests: 2, uncachedInputTokens: 150_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ],
  models: [
    { id: "gwm_sonnet", name: "Claude Sonnet 5", providerName: "Anthropic", providerId: "anthropic", upstreamModelId: "claude-sonnet-5", seriesId: SONNET,
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, contextTiers: [{ above: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }] } },
    { id: "gwm_luna", name: "GPT-6 Luna", providerName: "OpenAI", providerId: "openai", upstreamModelId: "gpt-6-luna", seriesId: LUNA,
      price: { input: 1, output: 4, cacheRead: null, cacheWrite: null, contextTiers: [] } },
    // The same upstream model through a second group is listed once.
    { id: "gwm_luna_2", name: "GPT-6 Luna", providerName: "OpenAI", providerId: "openai", upstreamModelId: "gpt-6-luna", seriesId: LUNA,
      price: { input: 1, output: 4, cacheRead: null, cacheWrite: null, contextTiers: [] } },
    { id: "gwm_private", name: "Private Model", providerName: "In-house", providerId: "custom", upstreamModelId: "private", seriesId: seriesId("custom", "private"), price: null },
  ],
});

test("key metrics: spend, requests, tokens and the top model come from the member's own report", () => {
  const metrics = gatewayMemberUsageMetrics(fixture.usage);
  assert.equal(metrics.spendMicroUsd, 7_100_000);
  assert.equal(metrics.requests, 12);
  assert.equal(metrics.tokens, 2_000_000);
  assert.equal(metrics.unpricedRequests, 1);
  assert.equal(metrics.topModel?.label, "Claude Sonnet 5");
  assert.equal(metrics.topModel?.costMicroUsd, 6_500_000);
  assert.equal(metrics.topModel?.tokens, 1_800_000);
});

test("spend with requests but no recorded price is unknown, not $0; no requests at all is $0", () => {
  const unpriced = { ...fixture.usage, totalCostMicroUsd: 0, unpricedRequests: 3, daily: fixture.usage.daily.map((entry) => ({ ...entry, totalCostMicroUsd: 0, costValues: Object.fromEntries(Object.keys(entry.costValues).map((id) => [id, null])) })) };
  assert.equal(gatewayMemberUsageMetrics(unpriced).spendMicroUsd, null);
  const empty = { ...fixture.usage, requestCount: 0, totalTokens: 0, totalCostMicroUsd: 0, unreportedRequests: 0, unpricedRequests: 0, series: [], daily: fixture.usage.daily.map((entry) => ({ ...entry, totalTokens: 0, totalCostMicroUsd: 0, values: {}, costValues: {} })) };
  const metrics = gatewayMemberUsageMetrics(empty);
  assert.equal(metrics.spendMicroUsd, 0);
  assert.equal(metrics.topModel, null);
});

test("cost comparison: the member's whole token mix times each model's listed price, cheapest first", () => {
  const comparison = gatewayModelCostComparison(fixture);
  assert.deepEqual(comparison.mix, { seriesId: "all", measuredRequests: 10, uncachedInputTokens: 1_150_000, outputTokens: 250_000, cacheReadTokens: 600_000, cacheWriteTokens: 0 });
  assert.equal(comparison.unmeasuredRequests, 2);
  assert.deepEqual(comparison.rows.map((row) => row.model.id), ["gwm_luna", "gwm_sonnet", "gwm_private"]);
  // Luna has no cache price, so cached tokens cost its input price: 1.15M + 0.6M at $1, 0.25M at $4.
  assert.equal(comparison.rows[0]?.estimateMicroUsd, 1_150_000 * 1 + 600_000 * 1 + 250_000 * 4);
  // Average context is 175k per request, under Sonnet's 200k tier: base prices, cache at the cache price.
  assert.equal(comparison.rows[1]?.estimateMicroUsd, 1_150_000 * 3 + 250_000 * 15 + 600_000 * 0.3);
});

test("a model without a listed price says so instead of costing $0", () => {
  const row = gatewayModelCostComparison(fixture).rows.find((entry) => entry.model.id === "gwm_private");
  assert.equal(row?.estimateMicroUsd, null);
  assert.equal(readGatewayListedPrice({ id: "x", name: "No cost" }), null);
  assert.equal(readGatewayListedPrice({ cost: { input: 1 } }), null);
});

test("context tiers apply by the average context per request, including cache tokens", () => {
  const price = readGatewayListedPrice({ cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, tiers: [{ tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache_read: 0.6 }] } });
  assert.ok(price);
  assert.deepEqual(price.contextTiers, [{ above: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 3.75 }]);
  const long = { measuredRequests: 1, uncachedInputTokens: 150_000, outputTokens: 1_000, cacheReadTokens: 50_000, cacheWriteTokens: 10_000 };
  assert.equal(estimateGatewayTokenMixCost(long, price), Math.round(150_000 * 6 + 1_000 * 22.5 + 50_000 * 0.6 + 10_000 * 3.75));
  const short = { ...long, measuredRequests: 2 };
  assert.equal(estimateGatewayTokenMixCost(short, price), Math.round(150_000 * 3 + 1_000 * 15 + 50_000 * 0.3 + 10_000 * 3.75));
  // Older catalogs only name the 200k tier.
  const legacy = readGatewayListedPrice({ cost: { input: 1, output: 2, context_over_200k: { input: 2, output: 4 } } });
  assert.deepEqual(legacy?.contextTiers, [{ above: 200_000, input: 2, output: 4, cacheRead: null, cacheWrite: null }]);
});

test("models the member spent on in the period are marked as what they use now", () => {
  const rows = gatewayModelCostComparison(fixture).rows;
  assert.deepEqual(rows.filter((row) => row.inUse).map((row) => row.model.id).sort(), ["gwm_luna", "gwm_sonnet"]);
  assert.equal(rows.find((row) => row.model.id === "gwm_sonnet")?.spentMicroUsd, 6_500_000);
  assert.equal(rows.find((row) => row.model.id === "gwm_private")?.inUse, false);
});

const capabilities: DenOrgCapabilities = { auditLogs: false, cloud: false, installLinks: false, mcpConnections: false, openworkWeb: false, workflows: false };

test("a member with no admin permissions gets Observability › My Usage", () => {
  const sections = buildDashboardNavSections({
    orgSlug: "acme", access: getOrgAccessFlags("member", false, []), capabilities, orgMode: "multi_org", runtimeConfigLoaded: true,
  });
  const observability = sections.find((section) => section.label === "Observability");
  assert.deepEqual(observability?.items.map((item) => [item.label, item.href]), [["My Usage", "/dashboard/my-usage"]]);
});
