import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  MEMBER_LIMIT_MICRO_USD,
  MEMBER_LIMIT_USED_MICRO_USD,
  MEMBER_REQUESTS,
  MEMBER_SPEND_MICRO_USD,
  MEMBER_TOKENS,
  MEMBER_USAGE_MODELS,
  PEER_SPEND_MICRO_USD,
  memberUsagePageWorld,
} from "../worlds/member-usage-page.ts";

const test = spec.world(memberUsagePageWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const usd = (microUsd: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(microUsd / 1_000_000);

test("any member sees their own spend limit, past 30 days and what each model would cost them", async ({ world, user, probe, step, evidence }) => {
  const text = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());

  await step("a regular member opens Observability › My Usage from the sidebar", async () => {
    await user.see({ text: "Observability" }, { timeoutMs: 90_000 });
    const links = await text('[data-testid="dashboard-nav-my-usage"]');
    await user.click({ testId: "dashboard-nav-my-usage" });
    await user.see({ text: "Spend limits" }, { timeoutMs: 60_000 });
    const api = await world.ownUsage();
    const ok = links.some((link) => link.includes("My Usage")) && api.status === 200;
    evidence.recordAssertionEvidence("A member with no admin permissions gets Observability › My Usage", `sidebar link: ${links.join(", ")}; GET /v1/gateway/usage/me as the member: HTTP ${api.status}`, ok);
    expect(ok).toBe(true);
  });

  await step("Spend limits shows how much of the monthly limit is used and when it resets", async () => {
    const used = `${usd(MEMBER_LIMIT_USED_MICRO_USD)} of ${usd(MEMBER_LIMIT_MICRO_USD)} used`;
    await user.see({ text: used }, { timeoutMs: 60_000 });
    const rows = await text('[data-testid="my-usage-limit-row"]');
    const limits = await world.ownLimits();
    const bucket = limits.buckets[0];
    const ok = rows.length === 1 && rows[0].includes("This month") && rows[0].includes("Resets") && rows[0].includes(`${Math.floor(((MEMBER_LIMIT_MICRO_USD - MEMBER_LIMIT_USED_MICRO_USD) * 100) / MEMBER_LIMIT_MICRO_USD)}% left`)
      && bucket?.usedMicroUsd === MEMBER_LIMIT_USED_MICRO_USD && bucket.allowanceMicroUsd === MEMBER_LIMIT_MICRO_USD;
    evidence.recordAssertionEvidence("The limit row matches the member's own limit", `row: ${rows.join(" | ")}; Den: used ${bucket?.usedMicroUsd} of ${bucket?.allowanceMicroUsd} micro-USD, resets ${bucket?.resetAt}`, ok);
    await user.screenshot();
    expect(ok).toBe(true);
  });

  await step("Past 30 days shows the seeded totals, and the chart switches between cost and tokens", async () => {
    await user.see({ text: "Top model" });
    const metrics = (await text('[data-analytics-stat]')).join(" | ");
    const { body } = await world.ownUsage();
    const matches = metrics.includes(usd(MEMBER_SPEND_MICRO_USD)) && metrics.includes(String(MEMBER_REQUESTS)) && metrics.includes(MEMBER_TOKENS.toLocaleString("en-US")) && metrics.includes("Claude Sonnet 5");
    const api = body?.usage.totalCostMicroUsd === MEMBER_SPEND_MICRO_USD && body.usage.requestCount === MEMBER_REQUESTS && body.usage.totalTokens === MEMBER_TOKENS;
    evidence.recordAssertionEvidence("Spend, requests, tokens and top model match the member's seeded requests", `on screen: ${metrics}; Den: ${body?.usage.totalCostMicroUsd} micro-USD, ${body?.usage.requestCount} requests, ${body?.usage.totalTokens} tokens`, matches && api);
    await user.see({ text: "Cost in USD per day" });
    await user.screenshot();
    await user.click({ role: "button", label: "Tokens" });
    await user.see({ text: "Reported tokens per day" });
    await user.screenshot();
    expect(matches).toBe(true);
    expect(api).toBe(true);
  });

  await step("Models you can use lists only the member's usable models, with prices and an estimate for their usage", async () => {
    const rows = await text('[data-testid="my-usage-catalog-row"]');
    const { body } = await world.ownUsage();
    const listed = body?.models.map((model) => model.upstreamModelId).sort() ?? [];
    const sonnet = rows.find((row) => row.startsWith("Claude Sonnet 5")) ?? "";
    const ok = rows.length === MEMBER_USAGE_MODELS.length && listed.join() === [...MEMBER_USAGE_MODELS].sort().join()
      && rows.every((row) => row.includes("per 1M tokens") && /\$\d/.test(row)) && sonnet.includes("What you use now");
    evidence.recordAssertionEvidence("Each usable model shows its listed price, an estimate for this member's tokens, and which one they use now", rows.join(" | "), ok);
    await user.screenshot();
    expect(ok).toBe(true);
  });

  await step("a teammate's usage on the same days never shows up", async () => {
    const page = (await text('[data-testid="my-usage"]')).join(" ");
    const { body } = await world.ownUsage();
    const hidden = !page.includes(usd(PEER_SPEND_MICRO_USD)) && body?.usage.totalCostMicroUsd === MEMBER_SPEND_MICRO_USD;
    evidence.recordAssertionEvidence("Only the member's own requests are counted", `teammate's ${usd(PEER_SPEND_MICRO_USD)} on the page: ${page.includes(usd(PEER_SPEND_MICRO_USD))}; member total from Den: ${body?.usage.totalCostMicroUsd}`, hidden);
    expect(hidden).toBe(true);
  });
});
