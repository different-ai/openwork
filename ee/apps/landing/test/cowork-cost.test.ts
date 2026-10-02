import { describe, expect, test } from "bun:test";

import {
  openworkEnterpriseSeatsMonthly,
  blendedTokenCostPerUser,
  cumulativeCosts,
  defaultMixShare,
  mixLabel,
  mixShares,
  perPersonMonthly,
  likelyExceedsTeamLimits,
  needsPremiumSeat,
  tokenCostPerUser,
  usageProfiles,
  type CumulativeInputs
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
const typical = usageProfiles.typical.usage;
// 25M × (0.3 × $2 + 0.7 × $0.2) + 1.2M × $10 = $18.50 + $12 = $30.50
const sonnetTypical = 30.5;

function inputs(overrides: Partial<CumulativeInputs> = {}): CumulativeInputs {
  return { users: 50, usage: typical, tier: "team", model: sonnet, mix: null, months: 36, ...overrides };
}

describe("token cost", () => {
  test("bills cached input at the cache-read price and the rest at the input price", () => {
    expect(tokenCostPerUser(sonnet, typical)).toBeCloseTo(sonnetTypical, 6);
  });

  test("falls back to the input price when a provider publishes no cache price", () => {
    const noCache = model({ input: 1, output: 2, cacheRead: null });
    expect(tokenCostPerUser(noCache, { inputMillions: 10, outputMillions: 1, cacheReadShare: 0.7 })).toBeCloseTo(12, 6);
  });

  test("clamps invalid shares and negative token counts", () => {
    expect(tokenCostPerUser(sonnet, { inputMillions: -5, outputMillions: -1, cacheReadShare: 2 })).toBe(0);
    expect(tokenCostPerUser(sonnet, { inputMillions: 1, outputMillions: 0, cacheReadShare: Number.NaN })).toBeCloseTo(2, 6);
  });

  test("flags Team limit risk and Premium seats from typical usage", () => {
    expect(likelyExceedsTeamLimits(usageProfiles.light.usage)).toBe(false);
    expect(likelyExceedsTeamLimits(typical)).toBe(true);
    expect(needsPremiumSeat(usageProfiles.light.usage)).toBe(false);
    expect(needsPremiumSeat(typical)).toBe(true);
    expect(needsPremiumSeat(usageProfiles.heavy.usage)).toBe(true);
  });
});

describe("cumulative costs", () => {
  test("compares Claude Team Premium with OpenWork Team on the same model at typical usage", () => {
    const result = cumulativeCosts(inputs());
    expect(result.claude.id).toBe("claude-team");
    expect(result.claudeTeamSeat).toBe("premium");
    expect(result.claude.name).toBe("Claude Team, Premium seats");
    expect(result.claude.seatsMonthly).toBe(50 * 100);
    expect(result.claude.tokensMonthly).toBe(0);
    expect(result.claude.tokensIncluded).toBe(true);
    expect(result.openwork.id).toBe("openwork-team");
    expect(result.openwork.modelLabel).toBe("Sonnet");
    expect(result.openwork.seatsBilled).toBe(45);
    expect(result.openwork.monthly).toBeCloseTo(45 * 10 + 50 * sonnetTypical, 6);
    expect(result.claude.total).toBeCloseTo(36 * 5000, 6);
  });

  test("50 people at typical usage over 3 years", () => {
    const result = cumulativeCosts(inputs({ mix: { openModel: cheap, openShare: 0.7 } }));
    // Claude Team Premium: 50 × $100 × 36 = $180,000. OpenWork Team: (45 × $10 + 50 × $30.50) × 36 = $71,100.
    expect(result.claude.total).toBeCloseTo(180_000, 6);
    expect(result.openwork.total).toBeCloseTo(71_100, 6);
    expect(result.savings).toBeCloseTo(108_900, 6);
    expect(result.mixSavings ?? 0).toBeGreaterThan(result.savings);
  });

  test("prices light usage on Claude Team Standard seats", () => {
    const light = usageProfiles.light.usage;
    const result = cumulativeCosts(inputs({ usage: light }));
    expect(result.claudeTeamSeat).toBe("standard");
    expect(result.claude.name).toBe("Claude Team");
    expect(result.claude.seatsMonthly).toBe(50 * 20);
    expect(result.savings).toBeCloseTo(36 * (1000 - (450 + 50 * tokenCostPerUser(sonnet, light))), 6);
  });

  test("builds cumulative points from zero, one per month", () => {
    const result = cumulativeCosts(inputs({ months: 12 }));
    expect(result.months).toBe(12);
    for (const line of [result.claude, result.openwork, result.claude3p]) {
      expect(line.points).toHaveLength(13);
      expect(line.points[0]).toBe(0);
      expect(line.points[12]).toBeCloseTo(line.total, 6);
      expect(line.points[6]).toBeCloseTo(line.monthly * 6, 6);
    }
    expect(cumulativeCosts(inputs({ months: 36 })).claude.total).toBeCloseTo(result.claude.total * 3, 6);
  });

  test("reports when OpenWork costs more instead of hiding it", () => {
    // A heavy Claude model at light usage: Claude Team Standard includes usage, OpenWork pays tokens at API rates.
    const opus = model({ id: "opus", label: "Opus", input: 10, output: 50, cacheRead: 1, claude: true });
    const result = cumulativeCosts(inputs({ usage: usageProfiles.light.usage, model: opus }));
    expect(result.savings).toBeLessThan(0);
  });

  test("Enterprise is a tie on seats and tokens with the same model", () => {
    const enterprise = cumulativeCosts(inputs({ users: 200, tier: "enterprise" }));
    expect(enterprise.openwork.seatsMonthly).toBe(200 * 20);
    expect(enterprise.claude.seatsMonthly).toBe(200 * 20);
    expect(enterprise.savings).toBeCloseTo(0, 6);
  });

  test("1000 people needing enterprise controls: volume tiers make OpenWork cheaper, the mix saves more", () => {
    const result = cumulativeCosts(inputs({ users: 1000, tier: "enterprise", mix: { openModel: cheap, openShare: 1 } }));
    expect(result.claude.id).toBe("claude-enterprise");
    expect(result.openwork.id).toBe("openwork-enterprise");
    expect(result.claude.total).toBeCloseTo(36 * 1000 * (20 + sonnetTypical), 6);
    // 250 seats at $20 + 750 at $16 = $17,000/mo vs Claude's $20,000/mo.
    expect(result.openwork.seatsMonthly).toBe(17_000);
    expect(result.savings).toBeCloseTo(36 * 3_000, 6);
    expect(result.mixSavings).toBeCloseTo(36 * (3_000 + 1000 * (sonnetTypical - tokenCostPerUser(cheap, typical))), 6);
  });

  test("OpenWork Enterprise volume tiers are graduated", () => {
    expect(openworkEnterpriseSeatsMonthly(20)).toBe(400);
    expect(openworkEnterpriseSeatsMonthly(250)).toBe(5_000);
    expect(openworkEnterpriseSeatsMonthly(251)).toBe(5_016);
    expect(openworkEnterpriseSeatsMonthly(1_000)).toBe(17_000);
    expect(openworkEnterpriseSeatsMonthly(2_000)).toBe(30_000);
    // A bigger team never costs less than a smaller one.
    expect(openworkEnterpriseSeatsMonthly(251)).toBeGreaterThan(openworkEnterpriseSeatsMonthly(250));
  });

  test("enterprise controls at 250 people or fewer is the same price on the same model", () => {
    const result = cumulativeCosts(inputs({ users: 200, tier: "enterprise" }));
    expect(result.savings).toBeCloseTo(0, 6);
  });

  test("first 5 seats are free on OpenWork Team", () => {
    expect(cumulativeCosts(inputs({ users: 3 })).openwork.seatsMonthly).toBe(0);
    expect(cumulativeCosts(inputs({ users: 5 })).openwork.seatsMonthly).toBe(0);
    expect(cumulativeCosts(inputs({ users: 6 })).openwork.seatsMonthly).toBe(10);
    expect(cumulativeCosts(inputs({ users: 6, tier: "enterprise" })).openwork.seatsMonthly).toBe(6 * 20);
  });

  test("applies Claude seat minimums", () => {
    expect(cumulativeCosts(inputs({ users: 1 })).claude.seatsMonthly).toBe(2 * 100);
    expect(cumulativeCosts(inputs({ users: 1, usage: usageProfiles.light.usage })).claude.seatsMonthly).toBe(2 * 20);
    const enterprise = cumulativeCosts(inputs({ users: 5, tier: "enterprise" }));
    expect(enterprise.claude.id).toBe("claude-enterprise");
    expect(enterprise.claude.seatsBilled).toBe(20);
    expect(enterprise.claude.monthly).toBeCloseTo(20 * 20 + 5 * sonnetTypical, 6);
  });

  test("falls back to Claude Enterprise when the team is too big for Claude Team", () => {
    const atCap = cumulativeCosts(inputs({ users: 150 }));
    expect(atCap.claude.id).toBe("claude-team");
    expect(atCap.claudeTeamUnavailable).toBe(false);
    const over = cumulativeCosts(inputs({ users: 151 }));
    expect(over.claudeTeamUnavailable).toBe(true);
    expect(over.claudeTeamSeat).toBeNull();
    expect(over.claude.id).toBe("claude-enterprise");
    expect(over.openwork.id).toBe("openwork-team");
    expect(cumulativeCosts(inputs({ users: 1000, tier: "enterprise" })).claudeTeamUnavailable).toBe(false);
  });

  test("uses Premium seats for heavy usage", () => {
    const result = cumulativeCosts(inputs({ usage: usageProfiles.heavy.usage }));
    expect(result.claudeTeamSeat).toBe("premium");
    expect(result.claude.seatsMonthly).toBe(50 * 100);
  });

  test("prices Claude Desktop on 3P as tokens only", () => {
    const result = cumulativeCosts(inputs({ users: 500, tier: "enterprise" }));
    expect(result.claude3p.seatsMonthly).toBe(0);
    expect(result.claude3p.monthly).toBeCloseTo(500 * sonnetTypical, 6);
    expect(result.claude3p.monthly).toBeLessThan(result.openwork.monthly);
  });

  test("adds a model-mix line with the same seats and blended tokens", () => {
    expect(cumulativeCosts(inputs()).mix).toBeNull();
    expect(cumulativeCosts(inputs({ mix: { openModel: cheap, openShare: 0 } })).mix).toBeNull();
    expect(cumulativeCosts(inputs({ mix: { openModel: cheap, openShare: 0 } })).mixSavings).toBeNull();
    const result = cumulativeCosts(inputs({ mix: { openModel: cheap, openShare: 0.7 } }));
    const mix = result.mix;
    if (!mix) throw new Error("missing mix line");
    expect(mix.id).toBe("openwork-team");
    expect(mix.modelLabel).toBe("70% Cheap, 30% Sonnet");
    expect(mix.seatsMonthly).toBe(result.openwork.seatsMonthly);
    expect(mix.tokensMonthly).toBeCloseTo(50 * (0.7 * tokenCostPerUser(cheap, typical) + 0.3 * sonnetTypical), 6);
    expect(result.mixSavings).toBeCloseTo(result.claude.total - mix.total, 6);
  });
});

describe("model mix", () => {
  test("offers 0, 50, 70, and 90 percent, defaulting to 70", () => {
    expect([...mixShares]).toEqual([0, 0.5, 0.7, 0.9]);
    expect(defaultMixShare).toBe(0.7);
  });

  test("blends token cost by the open-model share", () => {
    const cheapTypical = tokenCostPerUser(cheap, typical);
    const blend = (openShare: number) => blendedTokenCostPerUser(sonnet, { openModel: cheap, openShare }, typical);
    expect(blend(0)).toBeCloseTo(sonnetTypical, 6);
    expect(blend(0.5)).toBeCloseTo(0.5 * cheapTypical + 0.5 * sonnetTypical, 6);
    expect(blend(0.7)).toBeCloseTo(0.7 * cheapTypical + 0.3 * sonnetTypical, 6);
    expect(blend(0.9)).toBeCloseTo(0.9 * cheapTypical + 0.1 * sonnetTypical, 6);
    expect(blend(1)).toBeCloseTo(cheapTypical, 6);
    expect(blend(2)).toBeCloseTo(cheapTypical, 6);
  });

  test("labels the mix open model first", () => {
    expect(mixLabel(sonnet, { openModel: cheap, openShare: 0.9 })).toBe("90% Cheap, 10% Sonnet");
  });

  test("real prices: 50 people, typical, 3 years, by share", () => {
    const realSonnet = modelPrices.find((price) => price.id === "claude-sonnet-5");
    const deepseek = modelPrices.find((price) => price.id === "deepseek-v4-pro");
    if (!realSonnet || !deepseek) throw new Error("expected default models");
    const totals = mixShares.map(
      (openShare) =>
        cumulativeCosts({ ...inputs(), model: realSonnet, mix: { openModel: deepseek, openShare } }).mix?.total ?? null
    );
    const same = cumulativeCosts({ ...inputs(), model: realSonnet }).openwork.total;
    expect(totals[0]).toBeNull();
    // Each step toward the open model costs less than the last.
    let previous = same;
    for (const total of totals.slice(1)) {
      if (total === null) throw new Error("expected a mix line");
      expect(total).toBeLessThan(previous);
      previous = total;
    }
  });

  test("rounds cost per person per month to whole dollars", () => {
    const result = cumulativeCosts(inputs({ mix: { openModel: cheap, openShare: 0.7 } }));
    expect(perPersonMonthly(result.claude, 50)).toBe(100);
    // (45 × $10 + 50 × $30.50) / 50 = $39.50 → $40.
    expect(perPersonMonthly(result.openwork, 50)).toBe(40);
    const mix = result.mix;
    if (!mix) throw new Error("missing mix line");
    expect(perPersonMonthly(mix, 50)).toBe(Math.round(mix.monthly / 50));
    expect(Number.isInteger(perPersonMonthly(mix, 50))).toBe(true);
    // 200 people on Claude Enterprise: ($4,000 + 200 × $30.50) / 200 = $50.50 → $51.
    expect(perPersonMonthly(cumulativeCosts(inputs({ users: 200 })).claude, 200)).toBe(51);
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
