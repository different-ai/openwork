/**
 * Fake Stripe: a loopback, test-mode stand-in for the Stripe REST subset Den
 * uses, plus a Stripe-like hosted Checkout page a person can click through.
 *
 * Plain JavaScript (Node built-ins only) so it runs in a world, in Den's own
 * process (through models-egress-guard.mjs) and in den-api's API tests.
 *
 *   const stripe = await startFakeStripe({ secretKey, prices: [{ id, unitAmount, nickname }] });
 *   stripe.origin            // http://127.0.0.1:<port>
 *   stripe.state()           // { customers, sessions, subscriptions, requests }
 *   GET  /fixture/state      // the same, as JSON, for witnesses
 *   GET  /checkout/<id>      // "Test mode" page: line items, monthly total, Subscribe
 *   POST /checkout/<id>/pay  // completes the session, creates the subscription, 302 to success_url
 *
 * The Stripe API is served under both /v1/* and /stripe/v1/* (the egress
 * guard prefixes /stripe). Every API call needs `Authorization: Bearer <secretKey>`.
 * Nothing here can reach the real Stripe, and no card data exists.
 *
 * Supported: customers (search, list, create, retrieve), prices.retrieve,
 * checkout.sessions (create, retrieve, list, listLineItems, expire),
 * subscriptions (create, retrieve, update, list, cancel), subscriptionItems.update,
 * billingPortal.sessions.create, invoices.retrieve, setupIntents.retrieve.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const MONTH_SECONDS = 30 * 24 * 60 * 60;

function id(prefix) {
  return `${prefix}_test_${randomBytes(9).toString("hex")}`;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

/** Stripe's form encoding (`a[b][0][c]=v`) back into nested objects and arrays. */
export function parseStripeForm(text) {
  const root = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const path = key.replace(/\]/g, "").split("[");
    let node = root;
    path.forEach((segment, index) => {
      if (index === path.length - 1) node[segment] = value;
      else node = node[segment] ??= {};
    });
  }
  const arrays = (value) => {
    if (!value || typeof value !== "object") return value;
    const keys = Object.keys(value);
    const converted = Object.fromEntries(keys.map((key) => [key, arrays(value[key])]));
    return keys.length > 0 && keys.every((key) => /^\d+$/.test(key))
      ? keys.sort((a, b) => Number(a) - Number(b)).map((key) => converted[key])
      : converted;
  };
  return arrays(root);
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/**
 * Redirect the Stripe Node SDK's transport (not any Den function) to this
 * fake. Every request must carry the synthetic key and target api.stripe.com.
 * `sdkRoot` is the Stripe package directory the process under test loads.
 */
export async function redirectStripeSdk({ sdkRoot, port, secretKey, timeoutMs = 5_000 }) {
  const root = sdkRoot instanceof URL ? sdkRoot : pathToFileURL(sdkRoot.endsWith("/") ? sdkRoot : `${sdkRoot}/`);
  const esm = await import(new URL("esm/net/NodeHttpClient.js", root).href);
  const cjs = createRequire(import.meta.url)(fileURLToPath(new URL("cjs/net/NodeHttpClient.js", root)));
  for (const { NodeHttpClient } of [esm, cjs]) {
    const original = NodeHttpClient.prototype.__openworkOriginalMakeRequest ?? NodeHttpClient.prototype.makeRequest;
    NodeHttpClient.prototype.__openworkOriginalMakeRequest = original;
    NodeHttpClient.prototype.makeRequest = function (host, _port, path, method, headers, body, _protocol, timeout) {
      const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
      if (host !== "api.stripe.com" || authorization !== `Bearer ${secretKey}`) {
        throw new Error("Fake Stripe transport requires the synthetic credential and the expected SDK host");
      }
      return original.call(this, "127.0.0.1", Number(port), `/stripe${path}`, method, headers, body, "http", Math.min(timeout, timeoutMs));
    };
  }
}

/**
 * @param {{ secretKey: string; prices: { id: string; unitAmount: number; nickname: string; currency?: string; interval?: string }[]; port?: number; host?: string }} options
 */
export async function startFakeStripe(options) {
  const { secretKey } = options;
  if (!/^sk_test_/.test(secretKey)) throw new Error("Fake Stripe only accepts a synthetic sk_test_ key");
  const prices = new Map(options.prices.map((price) => [price.id, {
    id: price.id, object: "price", active: true, type: "recurring", billing_scheme: "per_unit", transform_quantity: null,
    unit_amount: price.unitAmount, currency: price.currency ?? "usd", nickname: price.nickname, product: `prod_${price.id}`,
    recurring: { interval: price.interval ?? "month", interval_count: 1, usage_type: "licensed" },
  }]));
  const customers = new Map();
  const sessions = new Map();
  const subscriptions = new Map();
  const declinedSubscriptionPayments = new Set();
  const invoices = new Map();
  const setupIntents = new Map();
  const portalSessions = new Map();
  const idempotent = new Map();
  const requests = [];
  let origin = "";

  const list = (data, url) => ({ object: "list", data, has_more: false, url });
  const notFound = (kind, value) => ({ status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${kind}: '${value}'` } } });
  const priceOf = (priceId) => prices.get(priceId) ?? null;

  function subscriptionItem(priceId, quantity) {
    const price = priceOf(priceId);
    if (!price) return null;
    const start = now();
    return { id: id("si"), object: "subscription_item", price, quantity: Number(quantity), current_period_start: start, current_period_end: start + MONTH_SECONDS };
  }

  function createSubscription({ customer, items, metadata }) {
    const created = now();
    const invoice = { id: id("in"), object: "invoice", status: "paid", amount_paid: 0, status_transitions: { paid_at: created }, parent: null };
    const subscription = {
      id: id("sub"), object: "subscription", customer, status: "active", metadata: { ...(metadata ?? {}) },
      items: { object: "list", data: items }, cancel_at_period_end: false, canceled_at: null, ended_at: null, created,
      current_period_start: created, current_period_end: created + MONTH_SECONDS, latest_invoice: invoice.id,
    };
    invoice.amount_paid = items.reduce((total, item) => total + item.price.unit_amount * item.quantity, 0);
    invoice.parent = { subscription_details: { subscription: subscription.id } };
    invoices.set(invoice.id, invoice);
    subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  function sessionAmount(session) {
    return session.line_items.reduce((total, item) => total + (priceOf(item.price)?.unit_amount ?? 0) * item.quantity, 0);
  }

  function publicSession(session) {
    const { line_items: _lineItems, ...rest } = session;
    return rest;
  }

  /** Completes a session the way Checkout would after a successful payment. */
  function completeSession(session) {
    if (session.status !== "open") return session;
    if (session.mode === "setup") {
      const intent = { id: id("seti"), object: "setup_intent", status: "succeeded", payment_method: id("pm"), metadata: session.setup_intent_data?.metadata ?? {} };
      setupIntents.set(intent.id, intent);
      Object.assign(session, { status: "complete", setup_intent: intent.id });
      return session;
    }
    const items = session.line_items.map((item) => subscriptionItem(item.price, item.quantity)).filter(Boolean);
    const subscription = createSubscription({ customer: session.customer, items, metadata: session.subscription_data?.metadata ?? {} });
    Object.assign(session, { status: "complete", payment_status: "paid", subscription: subscription.id, amount_total: sessionAmount(session) });
    return session;
  }

  function api(method, path, query, form) {
    const parts = path.split("/").filter(Boolean); // ["v1", ...]
    const [, resource, first, second] = parts;
    if (resource === "customers") {
      if (method === "GET" && first === "search") {
        const match = /metadata\['([^']+)'\]:'((?:[^'\\]|\\.)*)'/.exec(query.get("query") ?? "");
        const data = match ? [...customers.values()].filter((customer) => customer.metadata?.[match[1]] === match[2].replace(/\\(.)/g, "$1")) : [];
        return { status: 200, body: { object: "search_result", data, has_more: false, url: "/v1/customers/search" } };
      }
      if (method === "GET" && !first) {
        const email = query.get("email");
        return { status: 200, body: list([...customers.values()].filter((customer) => !email || customer.email === email), "/v1/customers") };
      }
      if (method === "POST" && !first) {
        const customer = { id: id("cus"), object: "customer", email: form.email ?? null, name: form.name ?? null, metadata: form.metadata ?? {}, created: now() };
        customers.set(customer.id, customer);
        return { status: 200, body: customer };
      }
      if (method === "GET" && first) return customers.has(first) ? { status: 200, body: customers.get(first) } : notFound("customer", first);
    }
    if (resource === "prices" && method === "GET" && first) {
      return prices.has(first) ? { status: 200, body: prices.get(first) } : notFound("price", first);
    }
    if (resource === "checkout" && first === "sessions") {
      const sessionId = second;
      const action = parts[4];
      if (method === "POST" && !sessionId) {
        const lineItems = (form.line_items ?? []).map((item) => ({ price: item.price, quantity: Number(item.quantity ?? 1) }));
        const unknown = lineItems.find((item) => !priceOf(item.price));
        if (unknown) return notFound("price", unknown.price);
        const session = {
          id: id("cs"), object: "checkout.session", mode: form.mode, status: "open", payment_status: form.mode === "setup" ? "no_payment_required" : "unpaid",
          customer: form.customer ?? null, client_reference_id: form.client_reference_id ?? null, metadata: form.metadata ?? {},
          success_url: form.success_url, cancel_url: form.cancel_url, subscription: null, setup_intent: null, currency: form.currency ?? "usd",
          amount_total: 0, created: now(), subscription_data: form.subscription_data ?? null, setup_intent_data: form.setup_intent_data ?? null,
          line_items: lineItems,
        };
        session.amount_total = sessionAmount(session);
        session.url = `${origin}/checkout/${session.id}`;
        sessions.set(session.id, session);
        return { status: 200, body: publicSession(session) };
      }
      if (method === "GET" && !sessionId) {
        const customer = query.get("customer");
        const data = [...sessions.values()].filter((session) => !customer || session.customer === customer).reverse().map(publicSession);
        return { status: 200, body: list(data, "/v1/checkout/sessions") };
      }
      const session = sessions.get(sessionId);
      if (!session) return notFound("checkout.session", sessionId);
      if (method === "GET" && !action) return { status: 200, body: publicSession(session) };
      if (method === "GET" && action === "line_items") {
        const data = session.line_items.map((item) => {
          const price = priceOf(item.price);
          return { id: id("li"), object: "item", description: price?.nickname ?? null, price, quantity: item.quantity, amount_total: (price?.unit_amount ?? 0) * item.quantity, currency: price?.currency ?? "usd" };
        });
        return { status: 200, body: list(data, `/v1/checkout/sessions/${session.id}/line_items`) };
      }
      if (method === "POST" && action === "expire") {
        if (session.status === "open") session.status = "expired";
        return { status: 200, body: publicSession(session) };
      }
    }
    if (resource === "subscriptions") {
      if (method === "POST" && !first) {
        const items = (form.items ?? []).map((item) => subscriptionItem(item.price, item.quantity ?? 1));
        if (items.some((item) => !item)) return notFound("price", "unknown");
        return { status: 200, body: createSubscription({ customer: form.customer, items, metadata: form.metadata }) };
      }
      if (method === "GET" && !first) {
        const customer = query.get("customer");
        const status = query.get("status");
        const data = [...subscriptions.values()].filter((subscription) => (!customer || subscription.customer === customer)
          && (status === "all" || (status ? subscription.status === status : subscription.status !== "canceled")));
        return { status: 200, body: list(data.reverse(), "/v1/subscriptions") };
      }
      const subscription = subscriptions.get(first);
      if (!subscription) return notFound("subscription", first);
      if (method === "GET") return { status: 200, body: subscription };
      if (method === "DELETE") {
        Object.assign(subscription, { status: "canceled", canceled_at: now(), ended_at: now() });
        return { status: 200, body: subscription };
      }
      if (method === "POST") {
        if (form.proration_behavior === "always_invoice" && declinedSubscriptionPayments.has(subscription.id)) {
          // Stripe rejects the entire update with error_if_incomplete; price,
          // quantity and metadata remain unchanged when collection fails.
          if (form.payment_behavior === "error_if_incomplete") {
            return { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } } };
          }
          subscription.status = "past_due";
        }
        for (const change of form.items ?? []) {
          const item = subscription.items.data.find((entry) => entry.id === change.id);
          if (!item) return notFound("subscription_item", change.id);
          if (change.price) {
            const price = priceOf(change.price);
            if (!price) return notFound("price", change.price);
            item.price = price;
          }
          if (change.quantity !== undefined) item.quantity = Number(change.quantity);
        }
        if (form.metadata) subscription.metadata = { ...subscription.metadata, ...form.metadata };
        if (form.cancel_at_period_end !== undefined) subscription.cancel_at_period_end = form.cancel_at_period_end === "true";
        return { status: 200, body: subscription };
      }
    }
    if (resource === "subscription_items" && method === "POST" && first) {
      const subscription = [...subscriptions.values()].find((entry) => entry.items.data.some((item) => item.id === first));
      const item = subscription?.items.data.find((entry) => entry.id === first);
      if (!item) return notFound("subscription_item", first);
      if (form.quantity !== undefined) item.quantity = Number(form.quantity);
      if (form.price) item.price = priceOf(form.price) ?? item.price;
      return { status: 200, body: item };
    }
    if (resource === "billing_portal" && first === "sessions" && method === "POST") {
      const portal = { id: id("bps"), object: "billing_portal.session", customer: form.customer, return_url: form.return_url ?? null };
      portal.url = `${origin}/portal/${portal.id}`;
      portalSessions.set(portal.id, portal);
      return { status: 200, body: portal };
    }
    if (resource === "invoices" && method === "GET" && first) {
      return invoices.has(first) ? { status: 200, body: invoices.get(first) } : notFound("invoice", first);
    }
    if (resource === "setup_intents" && method === "GET" && first) {
      return setupIntents.has(first) ? { status: 200, body: setupIntents.get(first) } : notFound("setup_intent", first);
    }
    return { status: 400, body: { error: { type: "invalid_request_error", message: `Fake Stripe does not support ${method} ${path}` } } };
  }

  function checkoutPage(session) {
    const rows = session.line_items.map((item) => {
      const price = priceOf(item.price);
      const total = (price?.unit_amount ?? 0) * item.quantity;
      const interval = price?.recurring.interval ?? "month";
      return `<li data-testid="fake-stripe-line-item"><span class="name">${escapeHtml(price?.nickname ?? item.price)}</span>`
        + `<span class="math">${item.quantity} × ${money(price?.unit_amount ?? 0)} = ${money(total)} / ${escapeHtml(interval)}</span></li>`;
    }).join("");
    const setup = session.mode === "setup";
    const total = sessionAmount(session);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout (test mode)</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f8fa; color: #1a1f36; }
  main { max-width: 440px; margin: 64px auto; background: #fff; border: 1px solid #e3e8ee; border-radius: 12px; padding: 28px; }
  .mode { display: inline-block; background: #ffde92; color: #5d4200; font-weight: 600; font-size: 12px; border-radius: 6px; padding: 2px 8px; }
  h1 { font-size: 18px; margin: 14px 0 4px; } p { color: #697386; margin: 0 0 18px; }
  ul { list-style: none; padding: 0; margin: 0 0 18px; border-top: 1px solid #e3e8ee; }
  li { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e3e8ee; }
  .name { font-weight: 600; } .total { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 22px; }
  button { width: 100%; height: 42px; border: 0; border-radius: 8px; background: #635bff; color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; }
  a { display: block; text-align: center; margin-top: 14px; color: #697386; }
</style></head><body><main>
<span class="mode">Test mode</span>
<h1>${setup ? "Save a card for later" : "Subscribe"}</h1>
<p>No real card is charged. This page stands in for Stripe Checkout in tests.</p>
${setup ? "" : `<ul>${rows}</ul><div class="total" data-testid="fake-stripe-total"><span>Total per month</span><span>${money(total)} / month</span></div>`}
<form method="post" action="/checkout/${escapeHtml(session.id)}/pay"><button type="submit">${setup ? "Save card" : "Subscribe"}</button></form>
<a href="${escapeHtml(session.cancel_url ?? "/")}">Cancel</a>
</main></body></html>`;
  }

  function page(response, status, html) {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
  }

  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url ?? "/", "http://fake-stripe.test");
    const method = request.method ?? "GET";
    try {
      if (url.pathname === "/health") return void response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (url.pathname === "/fixture/state") {
        return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state()));
      }
      const checkout = /^\/checkout\/([^/]+)(\/pay)?$/.exec(url.pathname);
      if (checkout) {
        const session = sessions.get(checkout[1]);
        if (!session) return page(response, 404, "<!doctype html><p>This test checkout does not exist.</p>");
        if (checkout[2] && method === "POST") {
          completeSession(session);
          requests.push({ method, path: url.pathname });
          const location = String(session.success_url ?? "/").replace("{CHECKOUT_SESSION_ID}", session.id);
          return void response.writeHead(302, { location }).end();
        }
        if (session.status !== "open") return page(response, 410, "<!doctype html><p>This test checkout is no longer open.</p>");
        return page(response, 200, checkoutPage(session));
      }
      const portal = /^\/portal\/([^/]+)$/.exec(url.pathname);
      if (portal) {
        const session = portalSessions.get(portal[1]);
        if (!session) return page(response, 404, "<!doctype html><p>This test billing portal does not exist.</p>");
        return page(response, 200, `<!doctype html><main><span>Test mode</span><h1>Billing portal</h1><a href="${escapeHtml(session.return_url ?? "/")}">Return</a></main>`);
      }
      const apiPath = url.pathname.startsWith("/stripe/v1/") ? url.pathname.slice("/stripe".length) : url.pathname;
      if (!apiPath.startsWith("/v1/")) return void response.writeHead(404).end();
      requests.push({ method, path: apiPath, form: parseStripeForm(text) });
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${secretKey}`) {
        return void response.writeHead(401).end(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid API key provided" } }));
      }
      const idempotencyKey = method === "POST" ? request.headers["idempotency-key"] : undefined;
      const replayKey = typeof idempotencyKey === "string" ? `${apiPath}:${idempotencyKey}` : null;
      const result = replayKey && idempotent.has(replayKey) ? idempotent.get(replayKey) : api(method, apiPath, url.searchParams, parseStripeForm(text));
      if (replayKey && result.status < 400) idempotent.set(replayKey, result);
      response.writeHead(result.status).end(JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "api_error", message: String(error?.message ?? error) } }));
    }
  });

  function state() {
    return {
      customers: [...customers.values()],
      sessions: [...sessions.values()].map((session) => ({ ...publicSession(session), lineItems: session.line_items })),
      subscriptions: [...subscriptions.values()],
      requests: [...requests],
    };
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  // A world that fails before disposing must not keep the test process alive.
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake Stripe has no port");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    port: address.port,
    origin,
    state,
    /** Completes an open Checkout session without the page (API tests). */
    complete(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`No fake Checkout session ${sessionId}`);
      return publicSession(completeSession(session));
    },
    /** Moves a subscription to another status (for example canceled), as Stripe would. */
    setSubscriptionStatus(subscriptionId, status) {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new Error(`No fake subscription ${subscriptionId}`);
      subscription.status = status;
      return subscription;
    },
    /** Make immediate invoice collection fail or succeed for subscription updates. */
    setSubscriptionPaymentDeclined(subscriptionId, declined) {
      if (!subscriptions.has(subscriptionId)) throw new Error(`No fake subscription ${subscriptionId}`);
      if (declined) declinedSubscriptionPayments.add(subscriptionId);
      else declinedSubscriptionPayments.delete(subscriptionId);
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
