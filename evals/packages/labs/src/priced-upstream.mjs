// Deterministic OpenAI-chat-compatible upstream that reports a fixed cost per
// call, for AI Gateway usage-limit worlds. Standalone so it can be uploaded
// verbatim into a Daytona sandbox and run next to the Gateway
// (evals/packages/hosts startScriptOnSandbox), or spawned locally.
//
// Env: HOST, PORT, PRICED_UPSTREAM_KEY (required), PRICED_UPSTREAM_COST_USD (default 1).
// GET /health   -> { ok: true }
// GET /requests -> [{ path, model, authenticated }]   (witness log for probes)
// POST .../chat/completions -> one non-streaming completion whose usage.cost is the fixed cost
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3991);
const key = process.env.PRICED_UPSTREAM_KEY ?? "";
const cost = Number(process.env.PRICED_UPSTREAM_COST_USD ?? "1");
if (!key) throw new Error("PRICED_UPSTREAM_KEY is required");
if (!Number.isFinite(cost) || cost < 0) throw new Error("PRICED_UPSTREAM_COST_USD must be a nonnegative number");

/** @type {{ path: string; model: string; authenticated: boolean }[]} */
const requests = [];

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const path = request.url?.split("?")[0] ?? "";
  if (request.method === "GET" && path === "/health") return json(response, 200, { ok: true });
  if (request.method === "GET" && path === "/requests") return json(response, 200, requests);
  if (request.method !== "POST" || !path.endsWith("/chat/completions")) return response.writeHead(404).end();
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) return response.writeHead(413).end();
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const model = typeof body?.model === "string" ? body.model : "";
    const authenticated = request.headers.authorization === `Bearer ${key}`;
    requests.push({ path, model, authenticated });
    if (!authenticated) return json(response, 401, { error: { message: "invalid upstream key" } });
    if (body?.stream === true) return json(response, 400, { error: { message: "this fixture answers non-streaming requests only" } });
    return json(response, 200, {
      id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: "Complete" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24, cost },
    });
  } catch {
    return response.writeHead(400).end();
  }
}).listen(port, host, () => {
  console.log(`priced upstream listening on ${host}:${port}`);
});
