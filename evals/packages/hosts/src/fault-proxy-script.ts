export const FAULT_PROXY_SCRIPT = String.raw`import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PORT);
const upstream = new URL(process.env.UPSTREAM);
const apiUpstream = new URL(process.env.API_UPSTREAM);
const issuer = process.env.ISSUER;
const controlToken = process.env.CONTROL_TOKEN;
const rules = [];
const requests = [];
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function headerText(value) {
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function forwardedHeaders(source, host) {
  const nominated = new Set(headerText(source.connection).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || hopByHopHeaders.has(name) || nominated.has(name)) continue;
    headers[name] = value;
  }
  if (host) headers.host = host;
  return headers;
}

function faultTimes(value) {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 0) throw new Error("Fault times must be a non-negative integer, got " + value + ".");
  return value;
}

function takeRule(path) {
  for (const rule of rules) {
    if (rule.remaining <= 0 || !path.startsWith(rule.pathPrefix)) continue;
    rule.remaining -= 1;
    return rule;
  }
  return null;
}

function json(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(text);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeUpstreamResponse(client, status, message, headers) {
  if (message) client.writeHead(status, message, headers);
  else client.writeHead(status, headers);
}

function forward(incoming, client, faulted) {
  const path = incoming.url ?? "/";
  const onResponse = (response) => {
    const status = response.statusCode ?? 502;
    requests.push({ method: incoming.method ?? "GET", path, status, faulted, at: Date.now() });
    writeUpstreamResponse(client, status, response.statusMessage, forwardedHeaders(response.headers));
    response.pipe(client);
  };
  // Pin the upstream origin and take only the path from the caller. An
  // absolute-form request target (legal for proxy requests) would otherwise
  // steer this fetch at an arbitrary host, because new URL(absolute, base)
  // discards the base.
  const requested = new URL(path, "http://request-target.invalid");
  // Den Web redirects /api/den rather than proxying it. The fixture must
  // reach the actual API so strict clients need not follow bearer redirects.
  const apiRequest = /^\/api\/den(?:\/|$)/.test(requested.pathname);
  const destination = apiRequest ? apiUpstream : upstream;
  const upstreamPath = apiRequest
    ? apiUpstream.pathname.replace(/\/$/, "") + (requested.pathname.slice("/api/den".length) || "/")
    : requested.pathname;
  const options = {
    protocol: destination.protocol,
    hostname: destination.hostname,
    port: destination.port,
    path: upstreamPath + requested.search,
    method: incoming.method ?? "GET",
    headers: forwardedHeaders(incoming.headers, destination.host),
  };
  const outbound = destination.protocol === "https:"
    ? httpsRequest(options, onResponse)
    : httpRequest(options, onResponse);
  outbound.on("error", (error) => {
    if (client.headersSent) {
      client.destroy(error);
      return;
    }
    requests.push({ method: incoming.method ?? "GET", path, status: 502, faulted, at: Date.now() });
    json(client, 502, { error: error.message });
  });
  incoming.on("aborted", () => outbound.destroy());
  incoming.pipe(outbound);
}

async function control(incoming, response, path) {
  if (path === "/__openwork_faults/health" && incoming.method === "GET") {
    json(response, 200, { ok: true, issuer });
    return;
  }
  if (incoming.headers["x-openwork-fault-token"] !== controlToken) {
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  if (path === "/__openwork_faults/requests" && incoming.method === "GET") {
    json(response, 200, { requests });
    return;
  }
  if (path === "/__openwork_faults/clear" && incoming.method === "POST") {
    rules.length = 0;
    response.writeHead(204);
    response.end();
    return;
  }
  if (path === "/__openwork_faults/rules" && incoming.method === "POST") {
    try {
      const body = await readJson(incoming);
      const remaining = faultTimes(body.times);
      if (body.kind === "status") {
        rules.push({ kind: "status", pathPrefix: body.pathPrefix, statusCode: body.statusCode, body: body.body, remaining });
      } else if (body.kind === "latency") {
        rules.push({ kind: "latency", pathPrefix: body.pathPrefix, delayMs: body.delayMs, remaining });
      } else {
        throw new Error("Unknown fault kind.");
      }
      response.writeHead(204);
      response.end();
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  json(response, 404, { error: "Not found" });
}

const server = createServer((incoming, response) => {
  void (async () => {
    const path = incoming.url ?? "/";
    if (path.startsWith("/__openwork_faults")) {
      await control(incoming, response, path);
      return;
    }
    const rule = takeRule(path);
    if (rule?.kind === "status") {
      const body = JSON.stringify(rule.body ?? { error: "Injected HTTP " + rule.statusCode });
      requests.push({ method: incoming.method ?? "GET", path, status: rule.statusCode, faulted: true, at: Date.now() });
      response.writeHead(rule.statusCode, {
        "access-control-allow-origin": "*",
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
      });
      response.end(body);
      return;
    }
    if (rule?.kind === "latency") await delay(rule.delayMs);
    forward(incoming, response, rule !== null);
  })().catch((error) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, "0.0.0.0");
`;
