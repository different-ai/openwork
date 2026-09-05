import { expect } from "vitest";
import { denFetch, provisionOrg } from "@openwork/behaviors";
import { mockStripe } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

test("confirmed cancellation survives retries and stale events with its effective date", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ placement: "local", env: ["OPENWORK_EVAL_MYSQL_URL"] });
  await using stripe = await mockStripe();
  await using den = await server({ place, web: false, env: {
    OPENWORK_TEST_STRIPE_PORT: String(stripe.port), STRIPE_SECRET_KEY: "sk_test_cancellation",
    STRIPE_WEBHOOK_SECRET: "whsec_plan_test", STRIPE_INFERENCE_PRICE_ID: "price_team", STRIPE_SEAT_PRICE_ID: "price_team",
  } });
  const request = (path: string, method = "GET", body?: unknown) => denFetch(den.admin, path, {
    headers: { authorization: `Bearer ${den.admin.token}` }, method,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const billing = async () => {
    const result = await request("/v1/billing");
    expect(result.response.status).toBe(200);
    return result.body;
  };
  expect((await request("/v1/billing/stripe/checkout", "POST", { type: "inference" })).response.status).toBe(200);
  const id = stripe.complete("cs_1");
  const subscription = stripe.subscriptions.get(id)!;
  const stale = structuredClone(subscription);
  expect((await stripe.webhook(den.ref.apiUrl, "customer.subscription.created", subscription)).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { subscription: { status: "active", cancelAtPeriodEnd: false } } } });
  subscription.cancel_at_period_end = true;
  for (const payload of [subscription, subscription, stale]) {
    expect((await stripe.webhook(den.ref.apiUrl, "customer.subscription.updated", payload, true, "evt_cancellation_retry")).status).toBe(200);
    expect(await billing()).toMatchObject({ billing: { stripe: { subscription: {
      status: "active", cancelAtPeriodEnd: true, currentPeriodStart: "2026-09-01T00:00:00.000Z", currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    } } } });
  }
  evidence.recordAssertionEvidence("Scheduled cancellation persists with its effective date", "Duplicate and stale signed events retain cancellation on October 1; access remains active during the paid period", true);
  subscription.status = "canceled";
  for (const type of ["customer.subscription.deleted", "customer.subscription.deleted", "customer.subscription.updated"]) {
    expect((await stripe.webhook(den.ref.apiUrl, type, type.endsWith("updated") ? stale : subscription)).status).toBe(200);
    expect(await billing()).toMatchObject({ billing: { stripe: { hasActiveSubscription: false, subscription: { status: "canceled", cancelAtPeriodEnd: true } } } });
  }
  expect((await stripe.webhook(den.ref.apiUrl, "invoice.payment_failed", stripe.invoices.get(subscription.latest_invoice))).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { hasActiveSubscription: false, subscription: { status: "canceled" } } } });
  const other = await provisionOrg(den.ref, {});
  const otherBilling = await denFetch(other.admin, "/v1/billing", { headers: { authorization: `Bearer ${other.admin.token}` } });
  expect(otherBilling.body).toMatchObject({ billing: { stripe: { hasActiveSubscription: false, subscription: null } } });
  expect(stripe.calls.filter((call) => call.path.startsWith("/v1/subscriptions/") && call.method !== "GET")).toEqual([]);
  evidence.recordAssertionEvidence("Canceled subscriptions stay canceled without mutations or cross-organization effects", "Deleted-event retries and stale active updates do not restore access; unrelated organization has no subscription; reconciliation sends no subscription writes", true);
});
