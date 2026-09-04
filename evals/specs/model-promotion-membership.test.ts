import { createHmac } from "node:crypto";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { createAdmin, createOrg, eventually, mcpMock, needs, server, test } from "@openwork/testkit";
import { promotionInference, verifyPromotionFixtureEmail } from "../worlds/model-promotions.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected a string"); return value; }
function rows(value: unknown) { if (!Array.isArray(value)) throw new Error("Expected a list"); return value.map(object); }
function auth(session: DenSession, orgId?: string) { return { authorization: `Bearer ${session.token}`, ...(orgId ? { "x-openwork-org-id": orgId } : {}) }; }

test("a paid member activates a bounded model offer, uses its own credit, and keeps membership after expiry", { timeout: 900000 }, async ({ place, evidence }) => {
  needs({ commands: ["pnpm"] });
  await using den = await server({ place, web: true, mocks: { promotions: mcpMock({ port: 3986 }) },
    env: { STRIPE_SECRET_KEY: "sk_test_model_promotions_fixture", STRIPE_WEBHOOK_SECRET: "whsec_model_promotions_fixture", STRIPE_INFERENCE_PRICE_ID: "price_promo_monthly", STRIPE_TEST_API_URL: "http://127.0.0.1:3986",
      MODEL_PROMOTIONS_OPENROUTER_URL: "http://127.0.0.1:3986/api/v1", OPENROUTER_TEST_API_URL: "http://127.0.0.1:3986", OPENROUTER_MANAGEMENT_API_KEY: "sk-or-fixture-management", DEN_REQUIRE_EMAIL_VERIFICATION: "false" },
    org: { name: `Promotion operator ${Date.now()}` },
  });
  const operator = den.admin;
  const witness = den.mocks.promotions;
  const orgs = await denFetch(operator, "/v1/me/orgs", { headers: auth(operator) });
  const operatorOrgId = string(rows(object(orgs.body).orgs)[0].id);
  const now = Date.now();
  const terms = { displayName: "Coworker launch model", alias: "coworker-launch-model", upstreamModel: "openai/promotion-fixture", provider: "openai", description: "A bounded membership launch offer.", stripePriceId: "price_promo_monthly", startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 86400000).toISOString(), creditMicrousd: 30000, budgetMicrousd: 1000000, capacity: 1, durationSeconds: 60, activationDays: 1, newAccountsOnly: true, maxInputBytes: 32000, maxOutputTokens: 4096, inputUsdPerMillion: 1, outputUsdPerMillion: 2, feeReserveBps: 1500, requestsPerMinute: 30 };
  async function operatorPost(path: string, body: object) { return denFetch(operator, path, { method: "POST", headers: auth(operator), body: JSON.stringify(body) }); }
  const created = await operatorPost("/v1/admin/model-promotions", { slug: "coworker-launch-fixture", terms, key: "sk-or-witness-promotion-only" });
  expect(created.response.status, created.text).toBe(201);
  const id = string(object(created.body).id);
  const drafts = await denFetch(operator, "/v1/admin/model-promotions", { headers: auth(operator) });
  expect(drafts.text).not.toContain("sk-or-witness");
  expect((await denFetch(operator, "/v1/model-offers/public/coworker-launch-fixture")).response.status).toBe(404);
  const deniedDraft = await denFetch(operator, `/v1/model-offers/${id}/checkout`, { method: "POST", headers: auth(operator, operatorOrgId), body: JSON.stringify({ version: 1 }) });
  expect(deniedDraft.response.status).toBe(409);
  evidence.recordAssertionEvidence("Drafts hide the offer, cannot create checkout, and never return the provider key", "Draft page 404; checkout 409; admin payload excludes provider key", true);

  const enabled = await operatorPost(`/v1/admin/model-promotions/${id}/status`, { status: "active" });
  expect(enabled.response.status, enabled.text).toBe(200);
  const visit = await denFetch(den.ref, "/v1/model-offers/public/coworker-launch-fixture/visit", { method: "POST", body: "{}" });
  expect(visit.response.status, visit.text).toBe(200);
  const cookie = string(visit.response.headers.get("set-cookie")).split(";")[0];
  const oldAccount = await denFetch(operator, `/v1/model-offers/${id}/checkout`, { method: "POST", headers: { ...auth(operator, operatorOrgId), cookie }, body: JSON.stringify({ version: 1 }) });
  expect(oldAccount.response.status).toBe(403);
  expect(object(oldAccount.body).error).toBe("signup_required");

  const claimant = await createAdmin(den, { email: "promotion-claimant@launch.test", name: "Promotion Claimant", password: "PromotionFixture123!" });
  await verifyPromotionFixtureEmail(den, claimant.email);
  await using claimantOrg = await createOrg(den, "Promotion claimant workspace");
  const headers = { ...auth(claimant, claimantOrg.id), cookie };
  async function claimPost(path: string, body: object = {}) { return denFetch(claimant, path, { method: "POST", headers, body: JSON.stringify(body) }); }
  const attempts = await Promise.all([claimPost(`/v1/model-offers/${id}/checkout`, { version: 1 }), claimPost(`/v1/model-offers/${id}/checkout`, { version: 1 })]);
  for (const attempt of attempts) expect(attempt.response.status, attempt.text).toBe(200);
  const grantId = string(object(attempts[0].body).grantId);
  expect(object(attempts[1].body).grantId).toBe(grantId);
  const state = object(await (await fetch(`${witness.url}/__promotion/state`)).json());
  expect(rows(state.sessions)).toHaveLength(1);
  const session = rows(state.sessions)[0];
  const sessionId = string(session.id);
  expect((await claimPost(`/v1/model-offers/grants/${grantId}/activate`)).response.status).toBe(403);
  const crossMember = await denFetch(operator, `/v1/model-offers/grants/${grantId}/activate`, { method: "POST", headers: auth(operator, operatorOrgId), body: "{}" });
  expect(crossMember.response.status).toBe(404);
  const nonAdmin = await denFetch(claimant, "/v1/admin/model-promotions", { headers: auth(claimant) });
  expect(nonAdmin.response.status).toBe(403);
  evidence.recordAssertionEvidence("Eligible new signup reserves exactly one checkout; unpaid and other identities cannot activate", "Two checkout attempts return one grant and Stripe session; unpaid 403; other identity 404; non-operator admin access 403", true);

  const pay = await fetch(`${witness.url}/__promotion/pay/${sessionId}`, { method: "POST" });
  expect(pay.status).toBe(200);
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_promotion_invoice", object: "event", type: "invoice.paid", data: { object: { id: `in_${sessionId}`, object: "invoice", parent: { subscription_details: { subscription: `sub_${sessionId}` } } } } });
  const signature = createHmac("sha256", "whsec_model_promotions_fixture").update(`${timestamp}.${payload}`).digest("hex");
  for (let i = 0; i < 2; i++) {
    const webhook = await denFetch(den.ref, "/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload });
    expect(webhook.response.status, webhook.text).toBe(200);
  }
  const available = await claimPost(`/v1/model-offers/grants/${grantId}/refresh`);
  expect(rows(object(available.body).grants)[0].status).toBe("available");
  const beforeActivate = await denFetch(claimant, "/v1/llm-providers?scope=usable", { headers });
  expect(beforeActivate.text).not.toContain(terms.alias);
  await using inference = await promotionInference(den, witness.url);
  const activated = await claimPost(`/v1/model-offers/grants/${grantId}/activate`);
  expect(activated.response.status, activated.text).toBe(200);
  const expiry = string(object(object(activated.body).grant).expiresAt);
  const activatedAgain = await claimPost(`/v1/model-offers/grants/${grantId}/activate`);
  expect(object(object(activatedAgain.body).grant).expiresAt).toBe(expiry);
  const catalog = await denFetch(claimant, "/v1/llm-providers?scope=usable", { headers });
  expect(catalog.text).toContain(terms.alias);
  const provider = rows(object(catalog.body).llmProviders).find((p) => p.source === "openwork");
  expect(provider).toBeDefined();
  const connection = await denFetch(claimant, `/v1/llm-providers/${string(provider?.id)}/connect`, { headers });
  const key = string(object(object(connection.body).llmProvider).apiKey);
  const before = await denFetch(claimant, "/v1/inference", { headers });
  evidence.recordAssertionEvidence("Verified paid membership unlocks one grant and activation does not reset on retry", "Duplicate signed invoice event produces one available grant; model absent until activation; repeated activation preserves exact expiry", true);

  const complete = (body: object) => fetch(`${inference.url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: terms.alias, messages: [{ role: "user", content: "Help me plan my next task." }], ...body }) });
  const escaped = await complete({ provider: { only: ["other"] } });
  expect(escaped.status).toBe(400);
  const generated = await complete({ stream: true, max_tokens: 20000 });
  expect(generated.status, await generated.clone().text()).toBe(200);
  expect(await generated.text()).toContain("Your coworker plan is ready");
  const witnessAfter = object(await (await fetch(`${witness.url}/__promotion/state`)).json());
  const call = rows(witnessAfter.calls)[0];
  expect(call.model).toBe(terms.upstreamModel);
  expect(call.key).toBe("promotion");
  expect(call.max_tokens).toBe(4096);
  expect(object(call.provider).allow_fallbacks).toBe(false);
  const spent = await denFetch(claimant, "/v1/model-offers", { headers });
  expect(rows(object(spent.body).grants)[0].spentMicrousd).toBe(100);
  const after = await denFetch(claimant, "/v1/inference", { headers });
  expect(object(after.body).inference).toEqual(object(before.body).inference);
  evidence.recordAssertionEvidence("Inference uses the named offer, its restricted funding key, and promotional credit only", "Upstream sees configured model/provider/key/output cap; override rejected; 100 micro-USD settled; ordinary membership buckets unchanged", true);

  await fetch(`${witness.url}/__promotion/delay`, { method: "POST", body: JSON.stringify({ ms: 800 }) });
  const concurrent = await Promise.all([complete({}), complete({}), complete({})]);
  expect(concurrent.filter((r) => r.status === 200)).toHaveLength(2);
  expect(concurrent.filter((r) => r.status === 429)).toHaveLength(1);
  for (const response of concurrent) await response.text();
  const paused = await operatorPost(`/v1/admin/model-promotions/${id}/status`, { status: "paused" });
  expect(paused.response.status).toBe(200);
  expect((await complete({})).status).toBe(200);
  const stopped = await operatorPost(`/v1/admin/model-promotions/${id}/status`, { status: "stopped" });
  expect(stopped.response.status).toBe(200);
  const blocked = await complete({});
  expect(blocked.status).toBe(503);
  await operatorPost(`/v1/admin/model-promotions/${id}/status`, { status: "active" });
  await eventually(async () => {
    const result = await denFetch(claimant, "/v1/model-offers", { headers });
    return rows(object(result.body).grants)[0].status;
  }, { within: 75000, intervalMs: 1000, until: (status) => status === "expired", label: "Promotional credit expires on its original clock" });
  expect((await complete({})).status).toBe(403);
  const expiredModels = await denFetch(claimant, "/v1/llm-providers?scope=usable", { headers });
  expect(expiredModels.text).not.toContain(terms.alias);
  const membership = await denFetch(claimant, "/v1/inference", { headers });
  expect(object(object(membership.body).inference).subscribed).toBe(true);
  evidence.recordAssertionEvidence("Concurrent requests respect reservations; pause, stop, and expiry have distinct effects", "Two in-flight requests accepted, third rejected; pause permits an existing grant; stop blocks inference; original expiry removes model and rejects cached alias without ending membership", true);
});
