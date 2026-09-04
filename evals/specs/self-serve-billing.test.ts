import { expect } from "vitest";
import { denFetch, provisionOrg } from "@openwork/behaviors";
import { mockStripe } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

test("owners purchase plans and SSO; only verified current payments grant access", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ placement: "local" });
  await using stripe = await mockStripe();
  await using den = await server({ place, web: false, env: {
    OPENWORK_TEST_STRIPE_PORT: String(stripe.port), STRIPE_SECRET_KEY: "sk_test_plan", STRIPE_WEBHOOK_SECRET: "whsec_plan_test",
    STRIPE_TEAM_PRICE_ID: "price_team", STRIPE_ENTERPRISE_PRICE_ID: "price_enterprise", STRIPE_SSO_PRICE_ID: "price_sso",
    STRIPE_PLAN_PORTAL_CONFIGURATION_ID: "bpc_test", DEN_PLAN_GATING_ENABLED: "true",
  } });
  const request = (path: string, method = "GET", body?: unknown) => denFetch(den.admin, path, {
    headers: { authorization: `Bearer ${den.admin.token}` },
    method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const entitlements = async () => (await request("/v1/org")).body;
  const billing = async () => {
    const result = await request("/v1/billing");
    expect(result.response.status).toBe(200);
    return result.body;
  };
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "free" } } } });
  const invalid = await request("/v1/billing/plans/checkout", "POST", { product: "enterprise", quantity: 1, priceId: "price_free" });
  expect(invalid.response.status).toBe(400);
  expect((await request("/v1/billing/plans/checkout", "POST", { product: "sso" })).response.status).toBe(409);
  const memberCheckout = await denFetch(den.members.jordan, "/v1/billing/plans/checkout", {
    method: "POST", headers: { authorization: `Bearer ${den.members.jordan.token}` }, body: JSON.stringify({ product: "team" }),
  });
  expect(memberCheckout.response.status).toBe(403);
  const team = await request("/v1/billing/plans/checkout", "POST", { product: "team" });
  expect(team.response.status, team.text).toBe(200);
  const retry = await request("/v1/billing/plans/checkout", "POST", { product: "team" });
  expect(retry.body).toEqual(team.body);
  expect(stripe.sessions.size).toBe(1);
  const session = stripe.sessions.get("cs_1");
  expect(session).toMatchObject({ price: "price_team", quantity: 2 });
  const teamId = stripe.complete("cs_1", false);
  expect((await stripe.webhook(den.ref.apiUrl, "checkout.session.completed", session, false)).status).toBe(400);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "free" } } } });
  expect((await stripe.webhook(den.ref.apiUrl, "checkout.session.completed", session)).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "free" } } } });
  const teamSubscription = stripe.subscriptions.get(teamId)!;
  const invoice = stripe.invoices.get(teamSubscription.latest_invoice)!;
  invoice.status = "paid";
  expect((await stripe.webhook(den.ref.apiUrl, "invoice.paid", invoice)).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "team" }, seats: { freeSeatCount: 0 } } } });
  expect((await request("/v1/billing/plans/checkout", "POST", { product: "team" })).response.status).toBe(409);
  evidence.recordAssertionEvidence("Checkout is idempotent and unpaid or forged events cannot enable Team", "One checkout; invalid payload 400; unpaid Free; signed paid Team", true);
  expect(await entitlements()).toMatchObject({ entitlements: { sso: false, desktopPolicies: false, analytics: false } });
  const addon = await request("/v1/billing/plans/checkout", "POST", { product: "sso" });
  expect(addon.response.status, addon.text).toBe(200);
  expect(stripe.sessions.get("cs_2")).toMatchObject({ price: "price_sso", quantity: 1 });
  const ssoId = stripe.complete("cs_2");
  expect((await stripe.webhook(den.ref.apiUrl, "checkout.session.completed", stripe.sessions.get("cs_2"))).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { sso: { hasActiveSubscription: true } } } } });
  expect((await request("/v1/billing/plans/checkout", "POST", { product: "enterprise" })).response.status).toBe(409);
  expect(await entitlements()).toMatchObject({ entitlements: { sso: true, desktopPolicies: false, orgControls: false, analytics: false } });
  const other = await provisionOrg(den.ref, {});
  const otherBilling = await denFetch(other.admin, "/v1/billing", { headers: { authorization: `Bearer ${other.admin.token}` } });
  expect(otherBilling.body).toMatchObject({ billing: { stripe: { plans: { tier: "free", sso: { hasActiveSubscription: false } } } } });
  const crossSync = await denFetch(other.admin, "/v1/billing/stripe/checkout/sync", { headers: { authorization: `Bearer ${other.admin.token}` }, method: "POST", body: JSON.stringify({ sessionId: "cs_2" }) });
  expect(crossSync.response.status).toBe(404);
  evidence.recordAssertionEvidence("SSO is a flat add-on isolated to its organization", "SSO quantity 1; unrelated org stays Free; cross-org sync 404; Enterprise duplicate charge prevented", true);
  const ssoSubscription = stripe.subscriptions.get(ssoId)!;
  ssoSubscription.status = "canceled";
  expect((await stripe.webhook(den.ref.apiUrl, "customer.subscription.deleted", ssoSubscription)).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { sso: { hasActiveSubscription: false } } } } });
  const upgrade = await request("/v1/billing/plans/checkout", "POST", { product: "enterprise" });
  expect(upgrade.response.status, upgrade.text).toBe(200);
  expect(upgrade.body).toEqual({ url: "https://billing.stripe.test/confirm" });
  teamSubscription.items.data[0].price.id = "price_enterprise";
  teamSubscription.items.data[0].price.unit_amount = 4000;
  expect((await stripe.webhook(den.ref.apiUrl, "customer.subscription.updated", teamSubscription)).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "enterprise" }, seats: { unitAmount: 4000 }, web: { complimentaryAccess: true } } } });
  expect(await entitlements()).toMatchObject({ entitlements: { sso: true, desktopPolicies: true, analytics: true } });
  invoice.status = "open";
  expect((await stripe.webhook(den.ref.apiUrl, "invoice.payment_failed", invoice)).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "free" }, web: { complimentaryAccess: false } } } });
  expect((await stripe.webhook(den.ref.apiUrl, "invoice.paid", { ...invoice, status: "paid" })).status).toBe(200);
  expect(await billing()).toMatchObject({ billing: { stripe: { plans: { tier: "free" } } } });
  expect(await entitlements()).toMatchObject({ entitlements: { sso: false, desktopPolicies: false, analytics: false } });
  evidence.recordAssertionEvidence("Cancellation and failed renewal revoke access; stale success cannot restore it", "SSO canceled; Enterprise confirmed; latest unpaid invoice overrides stale invoice.paid", true);
});
