import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { User } from "@openwork/testkit";
import { liveBillingBrowser, liveBillingNeeds } from "../worlds/live-den-billing.ts";
import { recordField } from "../worlds/live-den-api.ts";

const test = spec.world(liveBillingBrowser, { needs: liveBillingNeeds, timeout: 240_000 });

async function openCheckout(world: Awaited<ReturnType<typeof liveBillingBrowser>>, user: User) {
  await user.navigate(world.den.webUrl);
  await user.type({ role: "textbox", label: "Email" }, world.inbox.email);
  await user.click({ role: "button", label: "Next" });
  await user.type({ role: "textbox", label: "Password" }, world.password);
  await user.click({ role: "button", label: "Sign in" });
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
  await user.navigate(`${world.den.webUrl}/dashboard/inference`);
  await user.click({ role: "button", label: "Subscribe" });
}

test(".live canceling Stripe Checkout leaves the workspace unsubscribed", async ({ world, user, probe, evidence }) => {
  await openCheckout(world, user);
  const location = await probe.eventually(() => world.location(), {
    within: 45_000, until: (url) => url.hostname === "checkout.stripe.com", label: "Stripe hosted Checkout",
  });
  expect(location.hostname).toBe("checkout.stripe.com");
  const checkout = await world.checkout();
  expect(checkout.status).toBe("open");
  expect(checkout.subscription).toBeNull();
  // The hosted Back link exercises Stripe's actual cancel_url return.
  await user.click({ role: "link", label: /back/i });
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
  const billing = await world.request("/v1/billing");
  expect(billing.response.status).toBe(200);
  expect(recordField(recordField(billing.body, "billing"), "stripe")?.hasActiveSubscription).toBe(false);
  expect((await world.checkout()).subscription).toBeNull();
  evidence.recordAssertionEvidence("Checkout cancellation", "Subscribe opened real Stripe Checkout; its Back link returned to Den without a Stripe subscription or active Den entitlement.", true);
});

test(".live a 100%-discounted Stripe subscription activates the workspace and survives reload", async ({ world, user, probe, evidence }) => {
  await openCheckout(world, user);
  await probe.eventually(() => world.location(), {
    within: 45_000, until: (url) => url.hostname === "checkout.stripe.com", label: "Stripe hosted Checkout",
  });
  const code = await world.makePromotion();
  await user.click({ text: /add promotion code/i });
  await user.type({ role: "textbox", label: /promotion code/i }, code);
  await user.click({ role: "button", label: "Apply" });
  await probe.eventually(() => world.assertFreeCheckout(), {
    within: 30_000, label: "owned 100% forever discount and zero checkout total",
  });
  // Never enter or use a real card. If Checkout still requires a payment method,
  // fail the journey rather than weaken the price assertion or bypass the UI.
  await user.notSee({ role: "textbox", label: /card number/i });
  await user.click({ role: "button", label: /subscribe/i });
  const completed = await probe.eventually(() => world.checkout(), {
    within: 90_000, until: (session) => session.status === "complete", label: "Stripe subscription completion",
  });
  expect(completed.amount_total).toBe(0);
  expect(["paid", "no_payment_required"]).toContain(completed.payment_status);
  const subscription = recordField(completed, "subscription");
  expect(subscription?.status).toBe("active");
  const invoice = recordField(subscription, "latest_invoice");
  expect(invoice?.amount_paid).toBe(0);
  expect(invoice?.amount_due).toBe(0);
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
  const billing = await probe.eventually(async () => {
    const result = await world.request("/v1/billing");
    expect(result.response.status).toBe(200);
    return recordField(recordField(result.body, "billing"), "stripe");
  }, { within: 90_000, until: (value) => value?.hasActiveSubscription === true, label: "Den paid entitlement" });
  expect(billing?.hasActiveSubscription).toBe(true);
  await user.navigate(`${world.den.webUrl}/dashboard/inference`);
  await user.reload();
  await user.see({ role: "button", label: /manage subscription|enable/i });
  await user.notSee({ role: "button", label: "Subscribe" });
  evidence.recordAssertionEvidence("Zero-cost subscription activation", "The owned permanent 100% promotion reduced checkout to zero; Stripe completed a subscription with a zero-paid invoice; Den activated it and retained the subscribed UI after reload.", true);
});
