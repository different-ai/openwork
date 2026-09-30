import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoworkCostCalculator } from "../components/cowork-cost-calculator";
import { cumulativeCosts, perPersonMonthly, usageProfiles, type Tier } from "../lib/cowork-cost";
import { modelPrices } from "../lib/model-prices";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const sonnet = modelPrices.find((model) => model.id === "claude-sonnet-5");
const deepseek = modelPrices.find((model) => model.id === "deepseek-v4-pro");

function defaults(users: number, tier: Tier = "team") {
  if (!sonnet || !deepseek) throw new Error("expected default models");
  const costs = cumulativeCosts({
    users,
    usage: usageProfiles.typical.usage,
    tier,
    model: sonnet,
    mix: { openModel: deepseek, openShare: 0.7 },
    months: 36
  });
  const mix = costs.mix;
  if (!mix) throw new Error("expected mix line");
  return { costs, mix, sonnet, deepseek };
}

describe("cost calculator results", () => {
  test("shows the same-model and 70/30 mix comparisons side by side", () => {
    const { costs, mix, sonnet, deepseek } = defaults(50);
    const page = text(renderToStaticMarkup(createElement(CoworkCostCalculator)));

    expect(page).toContain(`Same model on both (${sonnet.label})`);
    expect(page).toContain(`You keep ${dollars.format(costs.claude.total - costs.openwork.total)}`);
    expect(page).toContain(`Claude Team ${dollars.format(costs.claude.total)} vs OpenWork ${dollars.format(costs.openwork.total)}`);
    expect(page).toContain(`OpenWork with a 70/30 mix (70% ${deepseek.label}, 30% Sonnet 5)`);
    // The mix card is a total against Claude, not an increment on the first card.
    expect(page).toContain(`You keep ${dollars.format(costs.claude.total - mix.total)}`);
    expect(page).toContain(`Claude Team ${dollars.format(costs.claude.total)} vs OpenWork ${dollars.format(mix.total)}`);
    // Per person per month, Claude first.
    const claudePerPerson = dollars.format(perPersonMonthly(costs.claude, 50));
    expect(page).toContain(`${claudePerPerson} vs ${dollars.format(perPersonMonthly(costs.openwork, 50))} per person / month`);
    expect(page).toContain(`${claudePerPerson} vs ${dollars.format(perPersonMonthly(mix, 50))} per person / month`);

    expect(page).toContain("Model mix on OpenWork");
    expect(page).toContain("Share of work on an open model");
    expect(page).toContain(`70% ${deepseek.label}`);
    expect(page).toContain(`30% ${sonnet.label}`);
    expect(page).toContain("Claude model (both sides)");
    expect(page).toContain("assumes that share of each person's tokens runs on the open model");
    expect(page).not.toContain("Compare an open model on OpenWork");
    expect(page).not.toMatch(/rout(e|es|ing) /i);

    expect(page).toContain("SCIM, audit log, desktop policies");
    expect(page).toContain("Not needed");
    expect(page).not.toContain("SSO and admin controls");

    // Chart lines name vendor and model.
    expect(page).toContain("Claude Team · Sonnet 5 (Premium seats)");
    expect(page).toContain(`OpenWork · ${sonnet.label}`);
    expect(page).toContain("OpenWork · 70/30 DeepSeek + Sonnet");
    // The main page compares the Claude plan with OpenWork only; 3P has its own page.
    expect(page).not.toContain("Claude on 3P");
    expect(page).not.toContain("no sharing between teammates");
    // Breakdown table has the mix row.
    expect(page).toContain(mix.modelLabel);
  });

  test("200 people without enterprise controls compares Claude Enterprise with OpenWork Team", () => {
    const { costs, mix } = defaults(200);
    expect(costs.claude.id).toBe("claude-enterprise");
    expect(costs.openwork.id).toBe("openwork-team");
    const page = text(renderToStaticMarkup(createElement(CoworkCostCalculator, { defaultUsers: 200 })));
    expect(page).toContain("Claude Team stops at 150 seats, so this compares Claude Enterprise.");
    expect(page).toContain(`Claude Enterprise ${dollars.format(costs.claude.total)} vs OpenWork ${dollars.format(costs.openwork.total)}`);
    expect(page).toContain(`You keep ${dollars.format(costs.claude.total - mix.total)}`);
  });

  test("compares only against Claude's own plans, never Claude on 3P", () => {
    const page = text(renderToStaticMarkup(createElement(CoworkCostCalculator, { defaultUsers: 500 })));
    expect(page).not.toContain("3P");
    expect(page).toContain("Claude Enterprise");
  });
});
