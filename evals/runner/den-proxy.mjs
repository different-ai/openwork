/**
 * Tiny eval-only Den proxy.
 *
 * The desktop app only speaks the den-web topology and derives Den API calls
 * with ensureDenApiBasePath (`/api/den/*`). The local eval stack runs the bare
 * den-api, so this proxy exposes both bare paths and `/api/den/*` by stripping
 * that prefix before streaming requests upstream.
 */
import http from "node:http";

const listenPort = Number(process.env.DEN_PROXY_LISTEN_PORT);
const upstreamPort = Number(process.env.DEN_PROXY_UPSTREAM_PORT);
const DEN_PREFIX = "/api/den";
const AUTH_DELAY_CONTROL_PATH = "/__openwork_eval/auth-delay";
const authDelayControlEnabled = process.env.OPENWORK_EVAL_DEN_PROXY_CONTROL === "1";
let authDelayEnabled = false;
let authDelayCalls = 0;
const authDelayWaiters = new Set();

if (!Number.isInteger(listenPort) || listenPort <= 0) {
  console.error("DEN_PROXY_LISTEN_PORT must be a positive integer.");
  process.exit(1);
}

if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
  console.error("DEN_PROXY_UPSTREAM_PORT must be a positive integer.");
  process.exit(1);
}

function rewritePath(rawUrl) {
  const url = new URL(rawUrl ?? "/", "http://127.0.0.1");
  if (url.pathname === DEN_PREFIX || url.pathname.startsWith(`${DEN_PREFIX}/`)) {
    return `${url.pathname.slice(DEN_PREFIX.length) || "/"}${url.search}`;
  }
  return `${url.pathname}${url.search}`;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

function releaseAuthDelay() {
  authDelayEnabled = false;
  const waiters = [...authDelayWaiters];
  authDelayWaiters.clear();
  for (const resolve of waiters) resolve();
}

function isSessionValidation(rawUrl, method) {
  if (method !== "GET") return false;
  const pathname = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  return pathname === "/v1/me" || pathname === `${DEN_PREFIX}/v1/me`;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === AUTH_DELAY_CONTROL_PATH) {
    if (!authDelayControlEnabled) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (req.method === "POST" && requestUrl.searchParams.get("action") === "hold") {
      authDelayEnabled = true;
      authDelayCalls = 0;
    } else if (req.method === "POST" && requestUrl.searchParams.get("action") === "release") {
      releaseAuthDelay();
    } else if (req.method !== "GET") {
      writeJson(res, 400, { error: "invalid_action" });
      return;
    }
    writeJson(res, 200, {
      enabled: authDelayEnabled,
      calls: authDelayCalls,
      pending: authDelayWaiters.size,
    });
    return;
  }

  if (authDelayControlEnabled && authDelayEnabled && isSessionValidation(req.url, req.method)) {
    authDelayCalls += 1;
    await new Promise((resolve) => authDelayWaiters.add(resolve));
  }

  const upstreamReq = http.request({
    hostname: "127.0.0.1",
    port: upstreamPort,
    path: rewritePath(req.url),
    method: req.method,
    headers: req.headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Gateway\n");
  });

  req.pipe(upstreamReq);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`den proxy listening on :${listenPort} -> :${upstreamPort}${authDelayControlEnabled ? " (eval auth delay enabled)" : ""}`);
});
