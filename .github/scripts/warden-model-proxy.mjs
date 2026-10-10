#!/usr/bin/env node
// Model proxy for the contributor Warden sandbox (contributor-warden.yml).
//
// Warden reviews untrusted fork code, and text in that code can steer the
// model. So Warden runs in a container with no API key and no internet; its
// only route out is this proxy, which runs in a separate container, holds the
// real key, and forwards a narrow set of requests:
//
//   - only POST /v1/responses (the API Warden's Pi runtime uses)
//   - only the models named in ALLOWED_MODELS
//   - only function tools: no hosted tools (web search, MCP, code
//     interpreter, file search) that would give the model a way out
//   - at most MAX_REQUESTS requests per run
//
// The caller's Authorization header is dropped; the real key is added here.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function checkRequest({ method, url, body, allowedModels, count, maxRequests }) {
  if (method !== "POST" || url !== "/v1/responses") return { ok: false, status: 404, reason: `blocked ${method} ${url}` };
  if (count >= maxRequests) return { ok: false, status: 429, reason: `request budget of ${maxRequests} used` };
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, reason: "body is not JSON" };
  }
  if (!allowedModels.includes(json?.model)) return { ok: false, status: 403, reason: `model ${String(json?.model)} is not allowed` };
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const hosted = tools.find((tool) => tool?.type !== "function");
  if (hosted) return { ok: false, status: 403, reason: `tool type ${String(hosted?.type)} is not allowed` };
  for (const field of ["previous_response_id", "conversation", "background"]) {
    if (json[field] !== undefined && json[field] !== null && json[field] !== false) {
      return { ok: false, status: 403, reason: `${field} is not allowed` };
    }
  }
  return { ok: true };
}

function main() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required");
  const allowedModels = (process.env.ALLOWED_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
  if (!allowedModels.length) throw new Error("ALLOWED_MODELS is required");
  const maxRequests = Number(process.env.MAX_REQUESTS ?? 3000);
  const upstream = new URL(process.env.UPSTREAM ?? "https://api.openai.com");
  let count = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const check = checkRequest({ method: req.method, url: req.url, body, allowedModels, count, maxRequests });
      if (!check.ok) {
        console.log(`refused: ${check.reason}`);
        res.writeHead(check.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Blocked by the Warden sandbox proxy: ${check.reason}` } }));
        return;
      }
      count += 1;
      // UPSTREAM is only ever plain http for the local test double.
      const request = upstream.protocol === "http:" ? httpRequest : httpsRequest;
      const forward = request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: "POST",
        path: "/v1/responses",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          accept: req.headers.accept ?? "application/json",
        },
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          "content-type": upstreamRes.headers["content-type"] ?? "application/json",
        });
        upstreamRes.pipe(res);
      });
      forward.on("error", (error) => {
        console.log(`upstream error: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream error" } }));
      });
      forward.end(body);
    });
  });
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
    console.log(`warden model proxy ready; models: ${allowedModels.join(", ")}; budget: ${maxRequests} requests`);
  });
  process.on("SIGTERM", () => {
    console.log(`forwarded ${count} request(s)`);
    process.exit(0);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
