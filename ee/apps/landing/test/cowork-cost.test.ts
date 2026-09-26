import { describe, expect, test } from "bun:test";

import {
  blendedTokenCostPerUser,
  calculatePlanCosts,
  likelyExceedsTeamLimits,
  tokenCostPerUser,
  usageProfiles,
  type CostInputs,
  type PlanCost,
  type PlanId
} from "../lib/cowork-cost";
import { modelPrices, type ModelPrice } from "../lib/model-prices";

const model = (price: Partial<ModelPrice>): ModelPrice => ({
  id: "test",
  provider: "test",
  providerName: "Test",
  label: "Test",
  input: 2,
  output: 10,
  cacheRead: 0.2,
  claude: false,
  ...price
});

const sonnet = model({ id: "sonnet", label: "Sonnet", input: 2, output: 10, cacheRead: 0.2, claude: true });
const cheap = model({ id: "cheap", label: "Cheap", input: 0.4, output: 0.8, cacheRead: 0.004 });

function inputs(overrides: Partial<CostInputs> = {}): CostInputs {
  return {
    users: 500,
    usage: usageProfiles.typical.usage,
    claudeModel: sonnet,
    openworkModel: cheap,
    routeModel: cheap,
    routeShare: 0,
    claudeTeamBilling: "annual",
    ...overrides
  };
}

function byId(plans: PlanCost[], id: PlanId): PlanCost {
  const plan = plans.find((entry) => entry.id === id);
  if (!plan) throw new Error(`missing ${id}`);
  return plan;
}

describe("token cost", () => {
  test("bills cached input at the cache-read price and the rest at the input price", () => {
    // 25M × (0.3 × $2 + 0.7 × $0.2) + 1.2M × $10 = $18.50 + $12 = $30.50
    expect(tokenCostPerUser(sonnet, usageProfiles.typical.usage)).toBeCloseTo(30.5, 6);
  });

  test("falls back to the input price when a provider publishes no cache price", () => {
    const noCache = model({ input: 1, output: 2, cacheRead: null });
    expect(tokenCostPerUser(noCache, { inputMillions: 10, outputMillions: 1, cacheReadShare: 0.7 })).toBeCloseTo(12, 6);
  });

  test("clamps invalid shares and negative token counts", () => {
    expect(tokenCostPerUser(sonnet, { inputMillions: -5, outputMillions: -1, cacheReadShare: 2 })).toBe(0);
    expect(tokenCostPerUser(sonnet, { inputMillions: 1, outputMillions: 0, cacheReadShare: Number.NaN })).toBeCloseTo(2, 6);
  });

  test("blends two models by routed share", () => {
    const usage = usageProfiles.typical.usage;
    const blended = blendedTokenCostPerUser(sonnet, cheap, 0.25, usage);
    expect(blended).toBeCloseTo(0.75 * tokenCostPerUser(sonnet, usage) + 0.25 * tokenCostPerUser(cheap, usage), 6);
  });

  test("flags Team limit risk from the typical profile upward", () => {
    expect(likelyExceedsTeamLimits(usageProfiles.light.usage)).toBe(false);
    expect(likelyExceedsTeamLimits(usageProfiles.typical.usage)).toBe(true);
    expect(likelyExceedsTeamLimits(usageProfiles.heavy.usage)).toBe(true);
  });
});

describe("plan costs", () => {
  test("prices every plan for 500 typical users", () => {
    const plans = calculatePlanCosts(inputs());
    const claudeTokens = 500 * 30.5;
    expect(byId(plans, "claude-enterprise").totalMonthly).toBeCloseTo(500 * 20 + claudeTokens, 4);
    expect(byId(plans, "claude-3p").totalMonthly).toBeCloseTo(claudeTokens, 4);
    expect(byId(plans, "claude-3p").seatMonthly).toBe(0);
    const openworkTokens = 500 * tokenCostPerUser(cheap, usageProfiles.typical.usage);
    expect(byId(plans, "openwork-team").totalMonthly).toBeCloseTo(500 * 10 + openworkTokens, 4);
    const enterprise = byId(plans, "openwork-enterprise");
    expect(enterprise.totalMonthly).toBeCloseTo(500 * 40 + openworkTokens, 4);
    expect(enterprise.totalAnnual).toBeCloseTo(enterprise.totalMonthly * 12, 4);
    expect(enterprise.notes.join(" ")).toContain("Volume pricing above 250 users");
    expect(byId(plans, "claude-team-standard").available).toBe(false);
    expect(byId(plans, "claude-team-premium").available).toBe(false);
  });

  test("shows OpenWork as more expensive when it runs the same Claude model", () => {
    const plans = calculatePlanCosts(inputs({ openworkModel: sonnet }));
    expect(byId(plans, "openwork-enterprise").totalMonthly).toBeGreaterThan(byId(plans, "claude-enterprise").totalMonthly);
    expect(byId(plans, "openwork-team").totalMonthly).toBeGreaterThan(byId(plans, "claude-3p").totalMonthly);
  });

  test("applies Claude seat minimums and Team billing", () => {
    const plans = calculatePlanCosts(inputs({ users: 1, claudeTeamBilling: "monthly" }));
    expect(byId(plans, "claude-team-standard").seatMonthly).toBe(2 * 25);
    expect(byId(plans, "claude-team-premium").seatMonthly).toBe(2 * 125);
    expect(byId(plans, "claude-enterprise").seatMonthly).toBe(20 * 20);
    expect(byId(plans, "openwork-team").notes.join(" ")).toContain("Free plan");
    const annual = calculatePlanCosts(inputs({ users: 100 }));
    expect(byId(annual, "claude-team-standard").seatMonthly).toBe(100 * 20);
    expect(byId(annual, "claude-team-standard").tokensMonthly).toBe(0);
    expect(byId(annual, "claude-team-standard").notes.join(" ")).toContain("weekly limits");
  });

  test("labels routed OpenWork usage", () => {
    const plans = calculatePlanCosts(inputs({ openworkModel: sonnet, routeModel: cheap, routeShare: 0.6 }));
    expect(byId(plans, "openwork-team").modelLabel).toBe("Sonnet + 60% Cheap");
  });
});

describe("model price snapshot", () => {
  test("contains the curated models with numeric prices", () => {
    const ids = modelPrices.map((entry) => entry.id);
    for (const id of ["claude-sonnet-5", "claude-opus-5-5", "deepseek-v4-pro", "glm-5.3", "gpt-6-sol", "kimi-k3"]) {
      expect(ids).toContain(id);
    }
    for (const entry of modelPrices) {
      expect(entry.input).toBeGreaterThanOrEqual(0);
      expect(entry.output).toBeGreaterThanOrEqual(0);
      expect(entry.claude).toBe(entry.provider === "anthropic");
    }
  });
});
