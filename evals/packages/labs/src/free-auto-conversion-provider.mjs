// Independent, loopback-only payment provider for the admin conversion journey.
import { createServer } from "node:http";
const port = Number(process.argv[2]);
let subscription = null;
let paid = true;
createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method === "POST" && request.url === "/fixture") {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    subscription = input.subscription;
    paid = input.paid;
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  let body;
  if (request.url === "/health") body = { ok: true };
  else if (request.url === `/stripe/v1/subscriptions/${subscription?.id}`) body = subscription;
  else if (request.url === "/stripe/v1/invoices/in_free_auto_conversion") body = {
    id: "in_free_auto_conversion", object: "invoice", status: paid ? "paid" : "open", amount_paid: paid ? 5000 : 0,
    parent: { subscription_details: { subscription: subscription?.id } }, status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  };
  else { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}).listen(port, "127.0.0.1");
