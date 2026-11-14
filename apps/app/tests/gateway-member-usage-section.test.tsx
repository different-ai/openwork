/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { GatewayMemberUsageResponse } from "@openwork/types/den/gateway-member-usage";

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let createRoot: typeof import("react-dom/client")["createRoot"];
let GatewayMemberUsageSections: typeof import("../src/react-app/domains/cloud/gateway-member-usage-section")["GatewayMemberUsageSections"];
let root: Root | null = null;
let host: HTMLDivElement;
let previousAct: unknown;
let missingRoute = false;
let requests = 0;
const opened: string[] = [];

const hex = (value: string) => Buffer.from(value).toString("hex").toUpperCase();
const SONNET = `model:${hex("anthropic")}:${hex("claude-sonnet-5")}`;
const LUNA = `model:${hex("openai")}:${hex("gpt-6-luna")}`;
const usage: GatewayMemberUsageResponse = {
  usage: {
    groupBy: "model", days: 2, from: "2026-11-12", to: "2026-11-13", timezone: "UTC",
    requestCount: 4, totalTokens: 1_000_000, unreportedRequests: 0, totalCostMicroUsd: 4_250_000, unpricedRequests: 0,
    series: [{ id: SONNET, label: "Claude Sonnet 5" }],
    daily: [
      { date: "2026-11-12", totalTokens: 600_000, values: { [SONNET]: 600_000 }, totalCostMicroUsd: 2_500_000, costValues: { [SONNET]: 2_500_000 } },
      { date: "2026-11-13", totalTokens: 400_000, values: { [SONNET]: 400_000 }, totalCostMicroUsd: 1_750_000, costValues: { [SONNET]: 1_750_000 } },
    ],
    filterOptions: [],
  },
  tokenMix: [{ seriesId: SONNET, measuredRequests: 4, uncachedInputTokens: 800_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  models: [
    { id: "gwm_sonnet", name: "Claude Sonnet 5", providerName: "Anthropic", providerId: "anthropic", upstreamModelId: "claude-sonnet-5", seriesId: SONNET, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: null, contextTiers: [] } },
    { id: "gwm_luna", name: "GPT-6 Luna", providerName: "OpenAI", providerId: "openai", upstreamModelId: "gpt-6-luna", seriesId: LUNA, price: { input: 1, output: 4, cacheRead: null, cacheWrite: null, contextTiers: [] } },
    { id: "gwm_private", name: "Private Model", providerName: "In-house", providerId: "custom", upstreamModelId: "private", seriesId: `model:${hex("custom")}:${hex("private")}`, price: null },
  ],
};

const scope = { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test", token: "token", organizationId: "org_test", generation: 1 };
mock.module("../src/app/lib/gateway-usage-scope", () => ({
  readGatewayUsageScope: () => scope,
  subscribeGatewayUsageScope: () => () => {},
}));
class DenApiError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}
mock.module("../src/app/lib/den", () => ({
  DenApiError,
  createDenClient: () => ({
    getGatewayMemberUsage: async (orgId: string) => {
      requests += 1;
      expect(orgId).toBe("org_test");
      if (missingRoute) throw new DenApiError(404);
      return usage;
    },
  }),
}));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ isSignedIn: true, verifiedIdentity: { organizationId: "org_test", principalId: "member_test" } }),
}));
mock.module("../src/react-app/kernel/platform", () => ({
  usePlatform: () => ({ openLink: (url: string) => { opened.push(url); } }),
}));

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  createRoot = (await import("react-dom/client")).createRoot;
  GatewayMemberUsageSections = (await import("../src/react-app/domains/cloud/gateway-member-usage-section")).GatewayMemberUsageSections;
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  missingRoute = false;
  requests = 0;
  opened.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
});

async function render() {
  const client = new QueryClient();
  await act(async () => root?.render(<QueryClientProvider client={client}><GatewayMemberUsageSections /></QueryClientProvider>));
  for (let attempt = 0; attempt < 20 && host.querySelector('[data-testid="gateway-member-usage-loading"]'); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

test("on a Den without the member usage route, the Usage settings show only the limits", async () => {
  missingRoute = true;
  await render();
  expect(requests).toBe(1);
  expect(host.textContent).toBe("");
});

test("the member sees their past 30 days and what each usable model would cost", async () => {
  await render();
  const metrics = host.querySelector('[data-testid="gateway-member-usage-metrics"]')?.textContent ?? "";
  expect(metrics).toContain("$4.25");
  expect(metrics).toContain("1,000,000");
  expect(metrics).toContain("Claude Sonnet 5");
  const rows = [...host.querySelectorAll('[data-testid="gateway-member-usage-catalog-row"]')].map((row) => row.textContent ?? "");
  // Cheapest for this usage first; Sonnet is what they use now; a model without a price says so.
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain("GPT-6 Luna");
  expect(rows[0]).toContain("$1.60");
  expect(rows[1]).toContain("Claude Sonnet 5");
  expect(rows[1]).toContain("What you use now");
  expect(rows[1]).toContain("$5.40");
  expect(rows[2]).toContain("No listed price");
  const open = [...host.querySelectorAll("button")].find((button) => button.textContent === "Open My Usage on the web");
  await act(async () => { open?.click(); });
  expect(opened).toEqual(["https://den.example.test/dashboard/my-usage"]);
});
