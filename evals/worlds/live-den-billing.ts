import { liveAccountBrowser, liveBrowserNeeds } from "./live-den-browser.ts";
import { isRecord, recordField, requiredEnv, stringField } from "./live-den-api.ts";

export const liveBillingNeeds = {
  ...liveBrowserNeeds,
  env: [...liveBrowserNeeds.env, "OPENWORK_EVAL_LIVE_STRIPE_SECRET_KEY"],
};

/** Stripe is a witness and cleanup boundary; Checkout itself is driven in the UI. */
export async function liveBillingBrowser() {
  const key = requiredEnv("OPENWORK_EVAL_LIVE_STRIPE_SECRET_KEY");
  const world = await liveAccountBrowser();
  let couponId: string | undefined;
  let promotionId: string | undefined;
  let checkoutId: string | undefined;
  let checkoutTagged = false;
  const testMetadata = { "metadata[synthetic]": "true", "metadata[live_eval_run]": world.run };

  async function stripe(path: string, method = "GET", values?: Record<string, string>) {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "stripe-version": "2026-04-22.dahlia", "content-type": "application/x-www-form-urlencoded" },
      body: values ? new URLSearchParams(values) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Stripe witness ${method} ${path.split("?")[0]}: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("Malformed Stripe witness response");
    return body;
  }
  function id(value: unknown) {
    const result = typeof value === "string" ? value : stringField(value, "id");
    if (!result) throw new Error("Missing Stripe object ID");
    return result;
  }
  function entries(value: unknown): Record<string, unknown>[] {
    if (!isRecord(value) || !Array.isArray(value.data) || !value.data.every(isRecord)) throw new Error("Malformed Stripe list");
    if (value.has_more === true) throw new Error("Unexpected pagination for an isolated test identity; refusing partial cleanup");
    return value.data;
  }
  async function customers() {
    const values = entries(await stripe(`/customers?email=${encodeURIComponent(world.inbox.email)}&limit=100`));
    for (const value of values) {
      if (stringField(recordField(value, "metadata"), "org_id") !== world.organizationId) {
        throw new Error("Stripe customer ownership mismatch; refusing mutation");
      }
    }
    return values;
  }
  return {
    ...world,
    async makePromotion() {
      const owned = await customers();
      if (owned.length !== 1) throw new Error("Open the owned checkout before creating its promotion");
      const coupon = await stripe("/coupons", "POST", {
        percent_off: "100", duration: "forever", max_redemptions: "1",
        redeem_by: String(Math.floor(Date.now() / 1000) + 3600),
        "metadata[live_eval_run]": world.run,
      });
      couponId = id(coupon);
      if (coupon.percent_off !== 100 || coupon.duration !== "forever") throw new Error("Expected a permanent 100% discount");
      const promotion = await stripe("/promotion_codes", "POST", {
        "promotion[type]": "coupon", "promotion[coupon]": couponId,
        customer: id(owned[0]),
        max_redemptions: "1", "metadata[live_eval_run]": world.run,
      });
      promotionId = id(promotion);
      const code = stringField(promotion, "code");
      if (!code) throw new Error("Missing promotion code");
      return code;
    },
    async checkout() {
      const owned = await customers();
      if (owned.length !== 1) throw new Error("Expected exactly one Stripe customer for the test workspace");
      const sessions = entries(await stripe(`/checkout/sessions?customer=${id(owned[0])}&limit=100`));
      const matching = sessions.filter((session) => session.client_reference_id === world.organizationId);
      if (matching.length !== 1) throw new Error("Expected exactly one owned Checkout session");
      checkoutId = id(matching[0]);
      if (!checkoutTagged) {
        await stripe(`/customers/${id(owned[0])}`, "POST", testMetadata);
        await stripe(`/checkout/sessions/${checkoutId}`, "POST", testMetadata);
        checkoutTagged = true;
      }
      return stripe(`/checkout/sessions/${checkoutId}?expand[]=discounts.coupon&expand[]=subscription.latest_invoice`);
    },
    async assertFreeCheckout() {
      if (!couponId || !promotionId) throw new Error("No owned discount");
      const session = await this.checkout();
      const discounts = session.discounts;
      if (session.status !== "open" || session.amount_total !== 0 || session.mode !== "subscription"
        || !Array.isArray(discounts) || !discounts.some((discount) => isRecord(discount)
          && id(discount.coupon) === couponId && id(discount.promotion_code) === promotionId)) {
        throw new Error("Refusing checkout: amount must be zero with the owned 100% forever promotion applied");
      }
      return session;
    },
    async [Symbol.asyncDispose]() {
      const errors: unknown[] = [];
      async function mark(path: string) {
        try { await stripe(path, "POST", testMetadata); } catch (error) { errors.push(error); }
      }
      // Discover by the unique mailbox even when the browser failed before observing a session.
      try {
        for (const customer of await customers()) {
          const customerId = id(customer);
          await mark(`/customers/${customerId}`);
          for (const session of entries(await stripe(`/checkout/sessions?customer=${customerId}&limit=100`))) {
            if (session.client_reference_id !== world.organizationId) throw new Error("Checkout ownership mismatch");
            await mark(`/checkout/sessions/${id(session)}`);
            if (session.status === "open") await stripe(`/checkout/sessions/${id(session)}/expire`, "POST");
          }
          for (const subscription of entries(await stripe(`/subscriptions?customer=${customerId}&status=all&limit=100`))) {
            if (stringField(recordField(subscription, "metadata"), "org_id") !== world.organizationId) throw new Error("Subscription ownership mismatch");
            await mark(`/subscriptions/${id(subscription)}`);
            if (!["canceled", "incomplete_expired"].includes(String(subscription.status))) {
              await stripe(`/subscriptions/${id(subscription)}`, "DELETE", { invoice_now: "false", prorate: "false" });
            }
          }
          await stripe(`/customers/${customerId}`, "DELETE");
        }
      } catch (error) { errors.push(error); }
      if (promotionId) {
        try { await stripe(`/promotion_codes/${promotionId}`, "POST", { active: "false" }); } catch (error) { errors.push(error); }
      }
      if (couponId) {
        try { await stripe(`/coupons/${couponId}`, "DELETE"); } catch (error) { errors.push(error); }
      }
      try { await world[Symbol.asyncDispose](); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, `Billing cleanup failed for ${world.run}`);
    },
  };
}
