import { createServer } from "node:http";
import { createHmac } from "node:crypto";

const priceAmounts: Record<string, number> = { price_team: 1000, price_enterprise: 4000, price_sso: 30000 };
type Subscription = {
  id: string; object: string; customer: string; status: string; metadata: Record<string, string>;
  latest_invoice: string; items: { data: { id: string; price: ReturnType<typeof price>; quantity: number; current_period_start: number; current_period_end: number }[] };
  cancel_at_period_end: boolean;
};
function price(id: string) {
  return { id, object: "price", active: true, type: "recurring", billing_scheme: "per_unit", transform_quantity: null,
    unit_amount: priceAmounts[id], currency: "usd", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };
}

export async function mockStripe() {
  const disabledPrices = new Set<string>();
  const customers = new Map<string, { id: string; metadata: Record<string, string> }>();
  const subscriptions = new Map<string, Subscription>();
  const sessions = new Map<string, { id: string; object: string; customer: string; metadata: Record<string, string>; mode: string; client_reference_id: string; status: string; url: string; subscription?: string; payment_status?: string; price: string; quantity: number }>();
  const invoices = new Map<string, { id: string; status: string; parent: { type: string; subscription_details: { subscription: string } } }>();
  const calls: { path: string; method: string; body: URLSearchParams }[] = [];
  const list = (data: unknown[]) => ({ object: "list", data, has_more: false, url: "/v1/mock" });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = new URLSearchParams(raw);
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push({ path: url.pathname, method: req.method ?? "GET", body });
    let result: unknown;
    if (url.pathname.startsWith("/v1/prices/")) {
      const id = url.pathname.split("/").at(-1) ?? "";
      result = { ...price(id), active: !disabledPrices.has(id) };
    }
    else if (url.pathname === "/v1/customers/search") result = { ...list([...customers.values()].filter((c) => url.searchParams.get("query")?.includes(c.metadata.org_id))), object: "search_result" };
    else if (url.pathname === "/v1/customers" && req.method === "POST") {
      const customer = { id: `cus_${customers.size + 1}`, metadata: { org_id: body.get("metadata[org_id]") ?? "" } };
      customers.set(customer.id, customer); result = customer;
    } else if (url.pathname.startsWith("/v1/customers/")) result = customers.get(url.pathname.split("/").at(-1) ?? "");
    else if (url.pathname === "/v1/customers") result = list([]);
    else if (url.pathname === "/v1/subscriptions") result = list([...subscriptions.values()].filter((s) => s.customer === url.searchParams.get("customer")));
    else if (url.pathname.startsWith("/v1/subscriptions/")) result = subscriptions.get(url.pathname.split("/").at(-1) ?? "");
    else if (url.pathname.startsWith("/v1/invoices/")) result = invoices.get(url.pathname.split("/").at(-1) ?? "");
    else if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") {
      const session = { id: `cs_${sessions.size + 1}`, object: "checkout.session", customer: body.get("customer") ?? "", mode: body.get("mode") ?? "", status: "open", url: `https://checkout.stripe.test/${sessions.size + 1}`,
        metadata: { org_id: body.get("metadata[org_id]") ?? "", subscription_type: body.get("metadata[subscription_type]") ?? "" },
        client_reference_id: body.get("client_reference_id") ?? "", price: body.get("line_items[0][price]") ?? "", quantity: Number(body.get("line_items[0][quantity]")) };
      sessions.set(session.id, session); result = session;
    } else if (url.pathname === "/v1/checkout/sessions") result = list([...sessions.values()].filter((s) => s.customer === url.searchParams.get("customer")).reverse());
    else if (url.pathname.startsWith("/v1/checkout/sessions/")) {
      const session = sessions.get(url.pathname.split("/")[4]);
      if (url.pathname.endsWith("/line_items")) result = list(session ? [{ price: price(session.price), quantity: session.quantity, current_period_start: 1788220800, current_period_end: 1790812800 }] : []);
      else if (url.pathname.endsWith("/expire") && session) { session.status = "expired"; result = session; }
      else result = session;
    } else if (url.pathname === "/v1/billing_portal/sessions") result = { id: "bps_mock", url: "https://billing.stripe.test/confirm" };
    else if (url.pathname.startsWith("/v1/subscription_items/")) result = { id: url.pathname.split("/").at(-1), quantity: Number(body.get("quantity")) };
    res.setHeader("content-type", "application/json");
    if (result === undefined) { res.statusCode = 404; result = { error: { message: `Mock Stripe: unhandled ${req.method} ${url.pathname}` } }; }
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock Stripe did not bind");
  let eventNumber = 0;
  return {
    port: address.port, calls, subscriptions, sessions, invoices, disabledPrices,
    complete(sessionId: string, paid = true) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Unknown checkout");
      session.status = "complete"; session.payment_status = paid ? "paid" : "unpaid";
      const id = `sub_${subscriptions.size + 1}`;
      session.subscription = id;
      const invoiceId = `in_${id}`;
      invoices.set(invoiceId, { id: invoiceId, status: paid ? "paid" : "open", parent: { type: "subscription_details", subscription_details: { subscription: id } } });
      subscriptions.set(id, { id, object: "subscription", customer: session.customer, status: "active", metadata: session.metadata,
        latest_invoice: invoiceId, cancel_at_period_end: false, items: { data: [{ id: `si_${id}`, price: price(session.price), quantity: session.quantity, current_period_start: 1788220800, current_period_end: 1790812800 }] } });
      return id;
    },
    async webhook(apiUrl: string, type: string, object: unknown, valid = true, eventId?: string) {
      const payload = JSON.stringify({ id: eventId ?? `evt_${++eventNumber}`, object: "event", type, data: { object } });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", valid ? "whsec_plan_test" : "invalid").update(`${timestamp}.${payload}`).digest("hex");
      return fetch(`${apiUrl}/v1/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload });
    },
    async [Symbol.asyncDispose]() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
