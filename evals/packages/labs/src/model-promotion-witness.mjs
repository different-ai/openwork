import { randomUUID } from "node:crypto";

// Deterministic Stripe/OpenRouter witness, hosted by the ordinary mcpMock
// process on either placement. It never contacts a real payment/model provider.
export function modelPromotionWitness() {
  const sessions = new Map();
  const subscriptions = new Map();
  const invoices = new Map();
  const idempotency = new Map();
  const generations = new Map();
  const calls = [];
  let delay = 0;
  const reply = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  async function body(req) { let value = ""; for await (const chunk of req) value += chunk; return value; }
  return async (req, res, url) => {
    const path = url.pathname;
    if (path === "/__promotion/state") { reply(res, { sessions: [...sessions.values()], calls }); return true; }
    if (path === "/__promotion/delay" && req.method === "POST") { delay = JSON.parse(await body(req)).ms; reply(res, { ok: true }); return true; }
    if (path.startsWith("/__promotion/inference/")) {
      const upstream = await fetch(`http://127.0.0.1:8799/${path.slice("/__promotion/inference/".length)}`, { method: req.method, headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" }, ...(req.method !== "GET" ? { body: await body(req) } : {}) });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end(); return true;
    }
    if (path.startsWith("/__promotion/pay/") && req.method === "POST") {
      const session = sessions.get(path.split("/").pop());
      if (!session) { reply(res, { error: "unknown_session" }, 404); return true; }
      session.status = "complete"; session.payment_status = "paid";
      session.subscription = `sub_${session.id}`; session.invoice = `in_${session.id}`;
      const now = Math.floor(Date.now() / 1000);
      subscriptions.set(session.subscription, { id: session.subscription, object: "subscription", status: "active", customer: session.customer, metadata: session.metadata, latest_invoice: session.invoice,
        items: { data: [{ id: `si_${session.id}`, quantity: 1, current_period_start: now, current_period_end: now + 2592000, price: { id: "price_promo_monthly", recurring: { interval: "month", interval_count: 1 } } }] }, current_period_start: now, current_period_end: now + 2592000, cancel_at_period_end: false });
      invoices.set(session.invoice, { id: session.invoice, object: "invoice", status: "paid", customer: session.customer, parent: { subscription_details: { subscription: session.subscription } }, amount_paid: 2000, amount_remaining: 0 });
      reply(res, { ok: true }); return true;
    }
    if (path.startsWith("/v1/prices/")) { reply(res, { id: path.split("/").pop(), object: "price", active: true, type: "recurring", unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } }); return true; }
    if (path === "/v1/checkout/sessions" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      const raw = await body(req);
      if (idempotency.has(key)) { reply(res, sessions.get(idempotency.get(key))); return true; }
      const params = new URLSearchParams(raw);
      const metadata = Object.fromEntries([...params].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
      const id = `cs_promo_${randomUUID().replaceAll("-", "")}`;
      const session = { id, object: "checkout.session", mode: "subscription", status: "open", payment_status: "unpaid", metadata, client_reference_id: params.get("client_reference_id"), customer: `cus_${id}`, subscription: null, invoice: null, url: `https://checkout.stripe.com/c/pay/${id}` };
      sessions.set(id, session); idempotency.set(key, id); reply(res, session); return true;
    }
    if (path.startsWith("/v1/checkout/sessions/")) { reply(res, sessions.get(path.split("/").pop()) ?? { error: "unknown_session" }); return true; }
    if (path.startsWith("/v1/subscriptions/")) { reply(res, subscriptions.get(path.split("/").pop()) ?? { error: "unknown_subscription" }); return true; }
    if (path.startsWith("/v1/invoices/")) { reply(res, invoices.get(path.split("/").pop()) ?? { error: "unknown_invoice" }); return true; }
    if (path === "/api/v1/key") { reply(res, { data: { limit: 1, limit_remaining: 1, limit_reset: null, include_byok_in_limit: true, is_management_key: false, expires_at: null } }); return true; }
    if (path.endsWith("/endpoints") && path.startsWith("/api/v1/models/")) { reply(res, { data: { endpoints: [{ tag: "openai", provider_name: "OpenAI", pricing: { prompt: "0.000001", completion: "0.000002" } }] } }); return true; }
    if (path === "/api/v1/keys" && req.method === "POST") { reply(res, { key: "sk-or-witness-ordinary-membership", data: { hash: randomUUID(), workspace_id: null } }, 201); return true; }
    if (path.startsWith("/api/v1/keys/") && req.method === "DELETE") { reply(res, { deleted: true }); return true; }
    if (path === "/api/v1/generation") { reply(res, { data: generations.get(url.searchParams.get("id")) }); return true; }
    if (path === "/api/v1/chat/completions" && req.method === "POST") {
      const input = JSON.parse(await body(req));
      calls.push({ model: input.model, provider: input.provider, max_tokens: input.max_tokens, requestId: input.session_id, key: req.headers.authorization === "Bearer sk-or-witness-promotion-only" ? "promotion" : "other" });
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const id = `gen-${randomUUID()}`;
      generations.set(id, { id, total_cost: 0.0001, is_byok: false, upstream_inference_cost: null });
      const completion = { id, object: "chat.completion", model: input.model, choices: [{ index: 0, message: { role: "assistant", content: "Your coworker plan is ready." }, finish_reason: "stop" }], usage: { cost: 0.0001, is_byok: false, prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      if (input.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`); }
      else reply(res, completion);
      return true;
    }
    return false;
  };
}
