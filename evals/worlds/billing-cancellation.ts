import type { Seed } from "@openwork/env";
import { mockStripe } from "@openwork/labs";

export async function billingCancellationWeb(seed: Seed) {
  const stripe = await mockStripe();
  try {
    const den = await seed.den({ env: {
      OPENWORK_TEST_STRIPE_PORT: String(stripe.port), STRIPE_SECRET_KEY: "sk_test_cancellation",
      STRIPE_WEBHOOK_SECRET: "whsec_plan_test", STRIPE_INFERENCE_PRICE_ID: "price_team", STRIPE_SEAT_PRICE_ID: "price_team",
    } });
    const checkout = await seed.api(den.admin, "/v1/billing/stripe/checkout", { method: "POST", body: JSON.stringify({ type: "inference" }) });
    if (checkout.response.status !== 200) throw new Error(`Fixture checkout failed: ${checkout.response.status}`);
    const subscription = stripe.subscriptions.get(stripe.complete("cs_1"))!;
    subscription.cancel_at_period_end = true;
    const seat = structuredClone(subscription);
    seat.id = "sub_seats";
    seat.metadata.subscription_type = "seat";
    stripe.subscriptions.set(seat.id, seat);
    for (const value of [subscription, seat]) {
      const response = await stripe.webhook(den.ref.apiUrl, "customer.subscription.updated", value);
      if (!response.ok) throw new Error(`Fixture webhook failed: ${response.status}`);
    }
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/billing", headless: true,
      viewport: { width: 1440, height: 1100 } });
    const effectiveDate = await seed.evalIn(web, `new Date("2026-10-01T00:00:00.000Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })`);
    if (typeof effectiveDate !== "string") throw new Error("Browser date formatting failed");
    return { den, web, effectiveDate, async [Symbol.asyncDispose]() { await stripe[Symbol.asyncDispose](); } };
  } catch (error) {
    await stripe[Symbol.asyncDispose]();
    throw error;
  }
}
