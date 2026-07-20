import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const targetValue = process.env.MCP_CONFORMANCE_TARGET_URL;
const tokenValue = process.env.MCP_CONFORMANCE_BEARER_TOKEN;
const port = Number(process.env.MCP_CONFORMANCE_PROXY_PORT ?? "8799");

if (!targetValue || !tokenValue) {
  throw new Error("MCP_CONFORMANCE_TARGET_URL and MCP_CONFORMANCE_BEARER_TOKEN are required.");
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("MCP_CONFORMANCE_PROXY_PORT must be a valid TCP port.");
}

const target = new URL(targetValue);
const loopback = target.hostname === "127.0.0.1" || target.hostname === "::1" || target.hostname === "localhost";
if ((target.protocol !== "https:" && !(target.protocol === "http:" && loopback))
  || target.username
  || target.password
  || target.search
  || target.hash
  || !target.pathname.endsWith("/mcp/agent")) {
  throw new Error("The conformance target must be an HTTPS /mcp/agent URL (HTTP is allowed only on loopback).");
}
if (/[\r\n]/u.test(tokenValue) || tokenValue.length > 8 * 1024) {
  throw new Error("The conformance bearer token is invalid.");
}
const authorization = tokenValue.startsWith("Bearer ") ? tokenValue : `Bearer ${tokenValue}`;
const allowedAuthorities = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
]);

function hasAllowedLoopbackAuthority(request) {
  const host = request.headers.host?.trim().toLowerCase();
  if (!host || !allowedAuthorities.has(host)) return false;
  const originValue = request.headers.origin?.trim();
  if (!originValue) return true;
  try {
    const origin = new URL(originValue);
    return origin.protocol === "http:"
      && allowedAuthorities.has(origin.host.toLowerCase())
      && (origin.hostname === "127.0.0.1" || origin.hostname === "localhost" || origin.hostname === "[::1]");
  } catch {
    return false;
  }
}

function copyRequestHeaders(source) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(source)) {
    if (rawValue === undefined) continue;
    const folded = name.toLowerCase();
    if (
      folded === "accept"
      || folded === "content-type"
      || folded === "last-event-id"
      || folded === "origin"
      || folded === "mcp-method"
      || folded === "mcp-name"
      || folded === "mcp-protocol-version"
      || folded === "mcp-session-id"
      || folded.startsWith("mcp-param-")
    ) {
      headers.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
    }
  }
  headers.set("authorization", authorization);
  return headers;
}

async function readRequestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(upstream) {
  const declared = upstream.headers.get("content-length");
  if (
    declared !== null
    && (/^\d+$/.test(declared) ? Number(declared) > MAX_RESPONSE_BYTES : true)
  ) {
    await upstream.body?.cancel();
    throw new Error("response_too_large");
  }
  if (!upstream.body) return new Uint8Array();
  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function copyResponseHeaders(source, destination) {
  for (const name of [
    "allow",
    "cache-control",
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "retry-after",
    "www-authenticate",
    "x-request-id",
  ]) {
    const value = source.get(name);
    if (value !== null) destination.setHeader(name, value);
  }
}

const server = createServer(async (request, response) => {
  if (!hasAllowedLoopbackAuthority(request)) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_loopback_origin" }));
    return;
  }
  if (request.url !== "/mcp") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  try {
    const body = await readRequestBody(request);
    const upstream = await fetch(target, {
      method: request.method,
      headers: copyRequestHeaders(request.headers),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    copyResponseHeaders(upstream.headers, response);
    const bytes = await readResponseBody(upstream);
    response.writeHead(upstream.status);
    response.end(bytes);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "request_too_large";
    const upstreamTooLarge = error instanceof Error && error.message === "response_too_large";
    response.writeHead(tooLarge ? 413 : 502, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: tooLarge
        ? "request_too_large"
        : upstreamTooLarge
          ? "upstream_response_too_large"
          : "upstream_unavailable",
    }));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`MCP conformance proxy listening on http://127.0.0.1:${port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
