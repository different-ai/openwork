import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";

const cookieName = "__Host-openwork-preview";
const configPath = process.env.OPENWORK_PREVIEW_ACCESS_FILE ?? "/opt/openwork-preview/access.json";
const upstreamPort = Number(process.env.OPENWORK_PREVIEW_UPSTREAM_PORT ?? 5178);

function equal(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function access(req) {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config.token || Date.parse(config.expiresAt) <= Date.now()) return null;
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return { config, authorized: equal(cookie, config.token) };
  } catch { return null; }
}

function headers(req) {
  // The access credential belongs to this gateway, never to the app or its logs.
  const { cookie, ...rest } = req.headers;
  const remaining = cookie?.split(";").filter((part) => !part.trim().startsWith(`${cookieName}=`)).join(";");
  return { ...rest, ...(remaining ? { cookie: remaining } : {}), host: `127.0.0.1:${upstreamPort}` };
}

export const server = createServer(async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  const auth = await access(req);
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/__openwork_launch" && req.method === "GET" && auth
    && equal(url.searchParams.get("token"), auth.config.token)) {
    const seconds = Math.max(0, Math.floor((Date.parse(auth.config.expiresAt) - Date.now()) / 1000));
    res.writeHead(303, {
      "set-cookie": `${cookieName}=${auth.config.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`,
      location: "/",
    });
    res.end();
    return;
  }
  if (!auth?.authorized) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Open this sandbox from your review launch link. If it has expired, launch a fresh sandbox.");
    return;
  }
  const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers: headers(req) }, (response) => {
    res.writeHead(response.statusCode ?? 502, { ...response.headers, "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
    response.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Sandbox unavailable. Launch a fresh sandbox from the review."); });
  req.pipe(upstream);
});

server.on("upgrade", async (req, socket, head) => {
  const auth = await access(req);
  // A cookie alone must not authorize a cross-site WebSocket.
  if (!auth?.authorized || (req.headers.origin && req.headers.origin !== `https://${req.headers.host}`)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, path: req.url, headers: headers(req) });
  upstream.on("upgrade", (response, peer, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    if (head.length) peer.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(peer).pipe(socket);
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
  });
  upstream.on("response", () => socket.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

server.listen(Number(process.env.OPENWORK_PREVIEW_GATEWAY_PORT ?? 8080), "0.0.0.0");
