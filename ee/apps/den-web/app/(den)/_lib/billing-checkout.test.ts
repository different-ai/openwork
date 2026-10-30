import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BillingNotConfiguredError,
  checkoutReturnDestination,
  checkoutReturnLabel,
  checkoutSuccessTitle,
  defaultTeamPeople,
  isCheckoutConfirmed,
  parseBillingNotConfigured,
  parseBillingPlans,
  parseBillingPlanSummary,
  parseBillingReturnTo,
  parseSeatPlanQuote,
  peopleLabel,
  startCheckout,
} from "./billing-checkout";

const plan = { tier: "free", source: "default", people: 6, joined: 5, invited: 1, freeSeatCount: 5 } as const;
const plans = {
  team: { available: true, unitAmount: 1000, currency: "usd", interval: "month" },
};

test("Den web refuses the same unsafe return targets as Den API", () => {
  assert.equal(parseBillingReturnTo("desktop"), "desktop");
  assert.equal(parseBillingReturnTo("/dashboard/members?invite=jordan%40acme.example"), "/dashboard/members?invite=jordan%40acme.example");
  for (const unsafe of ["https://evil.example/dashboard", "//evil.example", "/dashboard//x", "/dashboard\\x", "/admin", "/dashboard/../admin", null]) {
    assert.equal(parseBillingReturnTo(unsafe), null, String(unsafe));
  }
});

test("the billing summary, plan offers and the seat quote parse from the API shapes", () => {
  const payload = { billing: { stripe: {}, plan, plans } };
  assert.deepEqual(parseBillingPlanSummary(payload), { ...plan, userLimit: null, endsAt: null }, "older Den APIs omit the user limit and end date");
  assert.deepEqual(parseBillingPlanSummary({ billing: { plan: { ...plan, tier: "enterprise", source: "manual", userLimit: 20, endsAt: "2026-11-22" } } }),
    { ...plan, tier: "enterprise", source: "manual", userLimit: 20, endsAt: "2026-11-22" })
  assert.deepEqual(parseBillingPlans(payload), plans);
  assert.equal(parseBillingPlanSummary({ billing: { stripe: {} } }), null, "older Den APIs have no plan");
  assert.equal(parseBillingPlans({ billing: { plans: { team: {} } } }), null);

  const quote = { plan: "team", people: 6, joined: 5, invited: 0, unitAmount: 1000, monthlyTotal: 6000, currency: "usd", interval: "month", available: true };
  assert.deepEqual(parseSeatPlanQuote({ error: "payment_required", quote }), quote);
  assert.equal(parseSeatPlanQuote({ error: "payment_required" }), null);
  assert.equal(peopleLabel(plan), "6 people (5 joined, 1 invited)");
  assert.equal(peopleLabel({ people: 1, joined: 1, invited: 0 }), "1 person (1 joined, 0 invited)");
});

test("Team starts for everyone plus the next person once the free people are used", () => {
  assert.equal(defaultTeamPeople({ people: 5, freeSeatCount: 5 }, null), 6);
  assert.equal(defaultTeamPeople({ people: 3, freeSeatCount: 5 }, null), 3);
  assert.equal(defaultTeamPeople({ people: 5, freeSeatCount: 5 }, 2), 7);
  assert.equal(defaultTeamPeople({ people: 5, freeSeatCount: 5 }, 500), 55);
  assert.equal(defaultTeamPeople({ people: 0, freeSeatCount: 5 }, 0), 1);
});

test("startCheckout sends only a safe returnTo and returns where to go next", async () => {
  const sent: unknown[] = [];
  const result = await startCheckout({ type: "plan", plan: "team", addPeople: 1, returnTo: "https://evil.example" }, async (_path, init) => {
    sent.push(JSON.parse(String(init.body)));
    return { response: new Response(null, { status: 200 }), payload: { url: "https://checkout.example/cs_1" } };
  });
  assert.deepEqual(sent, [{ type: "plan", plan: "team", addPeople: 1 }]);
  assert.deepEqual(result, { url: "https://checkout.example/cs_1" });

  const completed = await startCheckout({ type: "plan", plan: "team", returnTo: "desktop" }, async (_path, init) => {
    sent.push(JSON.parse(String(init.body)));
    return { response: new Response(null, { status: 200 }), payload: { url: "/dashboard/billing/stripe/checking?return=plan", completed: true } };
  });
  assert.deepEqual(sent.at(-1), { type: "plan", plan: "team", returnTo: "desktop" });
  assert.equal(completed.completed, true);
});

test("a 503 billing_not_configured becomes a neutral not-sold error, other failures stay errors", async () => {
  const notSold = { error: "billing_not_configured", product: "inference", message: "OpenWork Models isn't sold on this deployment." };
  await assert.rejects(
    startCheckout({ type: "inference" }, async () => ({ response: new Response(null, { status: 503 }), payload: notSold })),
    (error: unknown) => error instanceof BillingNotConfiguredError && error.product === "inference" && error.message === notSold.message,
  );
  await assert.rejects(
    startCheckout({ type: "inference" }, async () => ({ response: new Response(null, { status: 409 }), payload: { error: "stripe_subscription_exists", message: "Already subscribed." } })),
    (error: unknown) => error instanceof Error && !(error instanceof BillingNotConfiguredError) && error.message === "Already subscribed.",
  );
  assert.equal(parseBillingNotConfigured({ error: "billing_not_configured", product: "unknown", message: "x" }), null);
});

test("the return page goes back to the dashboard page or offers Desktop, and names the destination", () => {
  assert.deepEqual(checkoutReturnDestination({ returnTo: "/dashboard/members?invite=a%40b.example", sessionId: "cs_1" }), {
    kind: "path", href: "/dashboard/members?invite=a%40b.example&checkout=complete&session_id=cs_1",
  });
  assert.deepEqual(checkoutReturnDestination({ returnTo: "desktop", sessionId: "cs_1" }), { kind: "desktop" });
  assert.equal(checkoutReturnDestination({ returnTo: "//evil.example", sessionId: "cs_1" }), null);
  assert.equal(checkoutReturnDestination({ returnTo: null, sessionId: null }), null);

  assert.equal(checkoutReturnLabel({ returnTo: "desktop", kind: "models" }), "Back to OpenWork Desktop");
  assert.equal(checkoutReturnLabel({ returnTo: "/dashboard/members?invite=x", kind: "plan" }), "Back to Members");
  assert.equal(checkoutReturnLabel({ returnTo: "/dashboard/ai-gateway?tab=openwork-models", kind: "models" }), "Back to OpenWork Models");
  assert.equal(checkoutReturnLabel({ returnTo: null, kind: "models" }), "Back to OpenWork Models");
  assert.equal(checkoutReturnLabel({ returnTo: null, kind: "web" }), "Back to OpenWork Web");
  assert.equal(checkoutReturnLabel({ returnTo: null, kind: "plan" }), "Back to Billing");
  assert.equal(checkoutReturnLabel({ returnTo: "/dashboard/somewhere-new", kind: "plan" }), "Back to the dashboard");

  assert.equal(checkoutSuccessTitle({ kind: "models", planTier: "free", organizationName: "Acme" }), "OpenWork Models is on for Acme");
  assert.equal(checkoutSuccessTitle({ kind: "plan", planTier: "team", organizationName: "Acme" }), "Team is active for Acme");
  assert.equal(checkoutSuccessTitle({ kind: "plan", planTier: "enterprise", organizationName: "Acme" }), "Enterprise is active for Acme");
});

test("each product's return page waits for its own purchase to show in billing", () => {
  const billing = (stripe: Record<string, unknown>, tier: "free" | "team" = "free") => ({ billing: { stripe, plan: { ...plan, tier, source: tier === "free" ? "default" : "stripe" }, plans } });
  assert.equal(isCheckoutConfirmed("models", billing({ hasActiveSubscription: true })), true);
  assert.equal(isCheckoutConfirmed("models", billing({ hasActiveSubscription: false, seats: { hasActiveSubscription: true } })), false);
  assert.equal(isCheckoutConfirmed("seat", billing({ seats: { hasActiveSubscription: true } })), true);
  assert.equal(isCheckoutConfirmed("plan", billing({ seats: { hasActiveSubscription: true } })), false, "the plan must change too");
  assert.equal(isCheckoutConfirmed("plan", billing({ seats: { hasActiveSubscription: true } }, "team")), true);
  assert.equal(isCheckoutConfirmed("web", billing({ web: { hasEligibleSubscription: true } })), true);
  assert.equal(isCheckoutConfirmed(null, billing({ hasActiveSubscription: true })), true);
  assert.equal(isCheckoutConfirmed("models", null), false);
});
