import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { planCheckoutSetsTierWorld } from "../worlds/plan-checkout-sets-tier.ts";

const test = spec.world(planCheckoutSetsTierWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = current && typeof current === "object" && key in current ? Object.fromEntries(Object.entries(current))[key] : undefined;
  return current;
}

test("an owner of a five-person workspace pays for Team for six people and the plan becomes Team", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner);
  const sandbox = user.on(world.sandbox);

  await step("before: Acme is on Free with five people, and Team for six is quoted as 6 × $10.00 = $60.00 per month", async () => {
    await owner.see({ testId: "billing-plan-card" }, { text: /5 people \(5 joined, 0 invited\)/, timeoutMs: 90_000 });
    await owner.see({ testId: "billing-plan-team-quote" }, { text: "6 people × $10.00 = $60.00 per month" });
    const before = await world.orgPlan(world.ownerSession, world.acmeId);
    expect(before.plan).toEqual({ tier: "free", source: "default" });
    expect(before.sso).toBe(false);
    evidence.recordAssertionEvidence("Acme starts on Free with Team features locked", `GET /v1/org → plan ${JSON.stringify(before.plan)}; entitlements.sso=${String(before.sso)}`, before.plan.tier === "free" && before.sso === false);
    await owner.screenshot();
  });

  await step("the owner starts Team and the test-mode payment page charges 6 × $10.00 = $60.00 / month", async () => {
    await owner.click({ role: "button", label: "Start Team" });
    await owner.see({ text: "Test mode" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "fake-stripe-line-item" }, { text: /Team plan\s*6 × \$10\.00 = \$60\.00 \/ month/ });
    const session = (await world.stripe.state()).sessions.find((entry) => entry.metadata.org_id === world.acmeId);
    expect(session?.lineItems).toEqual([{ price: "price_test_team_per_person", quantity: 6 }]);
    expect(session?.metadata).toMatchObject({ plan_tier: "team", pricing_model: "per_person", subscription_type: "seat", openwork_product: "openwork_plan" });
    expect(session?.success_url).toContain("/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=plan&returnTo=%2Fdashboard%2Fbilling");
    evidence.recordAssertionEvidence(
      "Checkout bills every person on the per-person Team price",
      `Checkout ${session?.mode} line items ${JSON.stringify(session?.lineItems)}; total ${session?.amount_total} cents; metadata plan_tier=${session?.metadata.plan_tier}, pricing_model=${session?.metadata.pricing_model}`,
      session?.lineItems[0]?.quantity === 6 && session.amount_total === 6000,
    );
    await owner.screenshot();
  });

  await step("after: paying returns through the synced return page to Billing, where Acme is on Team", async () => {
    await owner.click({ role: "button", label: "Subscribe" });
    await owner.see({ text: "Team is active for Acme." }, { timeoutMs: 90_000 });
    await owner.see({ testId: "billing-plan-card" }, { text: /Team/ });
    const location = new URL(await probe.on(world.owner).url());
    expect(location.pathname).toBe("/dashboard/billing");
    expect(location.searchParams.get("checkout")).toBe("complete");
    const after = await world.orgPlan(world.ownerSession, world.acmeId);
    expect(after.plan).toEqual({ tier: "team", source: "stripe" });
    expect(after.sso).toBe(true);
    const billing = await probe.api(world.ownerSession, "/v1/billing");
    expect(field(billing.body, "billing", "plan", "tier")).toBe("team");
    evidence.recordAssertionEvidence(
      "Payment set the plan and unlocked Team features",
      `returned to ${location.pathname}?checkout=${location.searchParams.get("checkout")}; GET /v1/org → plan ${JSON.stringify(after.plan)}, entitlements.sso=${String(after.sso)}; billing plan.tier=${String(field(billing.body, "billing", "plan", "tier"))}`,
      after.plan.tier === "team" && after.plan.source === "stripe" && after.sso === true,
    );
    await owner.screenshot();
  });

  await step("a buyer who came from OpenWork Desktop is told Team is active and offered the way back", async () => {
    await owner.navigate(world.url("/dashboard/billing/stripe/checking?return=plan&returnTo=desktop"));
    await owner.see({ testId: "checkout-return-desktop" }, { text: /Team is active for Acme/, timeoutMs: 60_000 });
    await owner.see({ role: "link", label: "Back to OpenWork Desktop" });
    const targets = await probe.on(world.owner).linkTargets('[data-testid="checkout-return-desktop"] a');
    expect(targets).toContain("openwork://");
    evidence.recordAssertionEvidence("Desktop return names what is on and links back to the app", `links: ${JSON.stringify(targets)}`, targets.includes("openwork://"));
    await owner.screenshot();
  });

  await step("OpenWork Models is a separate purchase and was not bought", async () => {
    await owner.navigate(world.url("/dashboard/billing"));
    await owner.see({ testId: "billing-ai-card" }, { text: /AI model access/, timeoutMs: 60_000 });
    const state = await world.stripe.state();
    const subscriptions = state.subscriptions.filter((entry) => entry.metadata.org_id === world.acmeId);
    const billing = await probe.api(world.ownerSession, "/v1/billing");
    expect(subscriptions.map((entry) => entry.metadata.subscription_type)).toEqual(["seat"]);
    expect(field(billing.body, "billing", "stripe", "hasActiveSubscription")).toBe(false);
    const refused = await world.stripe.refusedEgress();
    evidence.recordAssertionEvidence(
      "Only the plan subscription exists; no real Stripe was reached",
      `subscriptions for Acme: ${JSON.stringify(subscriptions.map((entry) => ({ type: entry.metadata.subscription_type, quantity: entry.items.data[0]?.quantity })))}; OpenWork Models active=${String(field(billing.body, "billing", "stripe", "hasActiveSubscription"))}; refused egress hosts=${JSON.stringify(refused)}`,
      subscriptions.length === 1 && field(billing.body, "billing", "stripe", "hasActiveSubscription") === false && !refused.includes("api.stripe.com"),
    );
  });

  await step("another workspace is offered Team with no feature flag, cannot buy Enterprise by card, and stays on Free", async () => {
    await sandbox.see({ testId: "billing-plan-card" }, { timeoutMs: 90_000 });
    await sandbox.see({ testId: "billing-plan-team-offer" });
    const refused = await world.startSandboxEnterpriseCheckout();
    expect(refused.status).toBe(400);
    expect(field(refused.body, "error")).toBe("invalid_request");
    const plan = await world.orgPlan(world.sandboxOwner, world.sandboxId);
    const sessions = (await world.stripe.state()).sessions.filter((entry) => entry.metadata.org_id === world.sandboxId);
    expect(plan.plan).toEqual({ tier: "free", source: "default" });
    expect(sessions).toHaveLength(0);
    evidence.recordAssertionEvidence(
      "Team is offered without a flag; Enterprise is never sold by card",
      `Team offer visible on Billing; POST checkout {type:"plan",plan:"enterprise"} → ${refused.status} ${String(field(refused.body, "error"))}; plan ${JSON.stringify(plan.plan)}; Checkout sessions for it: ${sessions.length}`,
      refused.status === 400 && plan.plan.tier === "free" && sessions.length === 0,
    );
    await sandbox.screenshot();
  });
});
