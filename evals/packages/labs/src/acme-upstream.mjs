// Deterministic Anthropic-compatible upstream for AI Gateway worlds.
// Standalone so it can be uploaded verbatim into a Daytona sandbox and run
// next to the gateway (evals/packages/hosts startScriptOnSandbox). Mirrors
// worlds/lib/acme-gateway.ts startAcmeUpstream: one accepted key, one model,
// one fixed reply, streaming and non-streaming.
//
// Env: HOST, PORT, ACME_UPSTREAM_KEY, ACME_MODEL, ACME_REPLY.
// GET /health   -> { ok: true }
// GET /requests -> [{ model, authenticated }]   (witness log for probes)
// POST /v1/messages -> Anthropic message or SSE stream
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3990);
const key = process.env.ACME_UPSTREAM_KEY ?? "";
const model = process.env.ACME_MODEL ?? "claude-haiku-4-5-20251001";
const reply = process.env.ACME_REPLY ?? "Acme AI Gateway is working.";
if (!key) throw new Error("ACME_UPSTREAM_KEY is required");

/** @type {{ model: string; authenticated: boolean }[]} */
const requests = [];

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const path = request.url?.split("?")[0];
  if (request.method === "GET" && path === "/health") return json(response, 200, { ok: true });
  if (request.method === "GET" && path === "/requests") return json(response, 200, requests);
  if (request.method !== "POST" || path !== "/v1/messages") return response.writeHead(404).end();
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) return response.writeHead(413).end();
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const requested = typeof body?.model === "string" ? body.model : "";
    const authenticated = request.headers["x-api-key"] === key;
    requests.push({ model: requested, authenticated });
    if (!authenticated) return response.writeHead(401).end();
    if (requested !== model) return response.writeHead(400).end();
    const message = {
      id: `msg_${randomUUID()}`, type: "message", role: "assistant", model,
      content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 12 },
    };
    if (body?.stream !== true) return json(response, 200, message);
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": randomUUID() });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 25, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch {
    response.writeHead(400).end();
  }
}).listen(port, host, () => {
  console.log(`acme upstream listening on ${host}:${port}`);
});
