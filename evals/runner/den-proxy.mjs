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

const server = http.createServer((req, res) => {
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
  console.log(`den proxy listening on :${listenPort} -> :${upstreamPort}`);
});
