import { pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { originReplacements, replaceOrigins, originTransform } from "./origins.mjs";
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

async function target(req, auth) {
  if (!auth?.config.origins) return { hostname: "127.0.0.1", port: upstreamPort };
  let name = Object.entries(auth.config.origins).find(([, origin]) => origin === `https://${req.headers.host}`)?.[0];
  if (!name) throw new Error("Unknown preview service");
  const services = JSON.parse(await readFile(process.env.OPENWORK_PREVIEW_SERVICES_FILE ?? "/opt/openwork-preview/services.json", "utf8"));
  let path = req.url;
  if ((name === "app" || name === "den") && /^\/api\/den(?:\/|\?|$)/.test(path)) {
    name = "api";
    path = path.replace(/^\/api\/den(?=\/|\?|$)/, "") || "/";
  } else if (name === "den" && /^(?:\/v1(?:\/|\?|$)|\/mcp(?:\/|\?|$)|\/health(?:\?|$)|\/oauth\/client-metadata\.json(?:\?|$))/.test(path)) {
    name = "api";
  }
  const url = new URL(services[name]);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid local service");
  return { hostname: "127.0.0.1", port: Number(url.port), path };
}

// An OAuth provider fetches Den's client metadata document from its client ID URL
// itself, without this sandbox's cookie. The document is public by design and
// names only this clone's callback.
function clientMetadata(req, auth) {
  if ((req.method !== "GET" && req.method !== "HEAD") || new URL(req.url, "http://localhost").pathname !== "/oauth/client-metadata.json") return false;
  const origin = `https://${req.headers.host}`;
  return origin === auth?.config.origins?.den || origin === auth?.config.origins?.api;
}

function headers(req, port = upstreamPort, pairs = []) {
  // The access credential belongs to this gateway, never to the app or its logs.
  const { cookie, ...rest } = req.headers;
  const remaining = cookie?.split(";").filter((part) => !part.trim().startsWith(`${cookieName}=`)).join(";");
  return { ...rest, ...(remaining ? { cookie: remaining } : {}),
    ...(typeof rest.origin === "string" ? { origin: replaceOrigins(rest.origin, pairs) } : {}),
    ...(typeof rest.referer === "string" ? { referer: replaceOrigins(rest.referer, pairs) } : {}),
    "accept-encoding": "identity", host: `127.0.0.1:${port}`,
    "x-forwarded-host": replaceOrigins(req.headers.host ?? "", pairs), "x-forwarded-proto": "https" };
}

function relay(response, res, pairs) {
  const outgoing = Object.fromEntries(Object.entries(response.headers).map(([key, value]) =>
    [key, Array.isArray(value) ? value.map((item) => replaceOrigins(item, pairs)) : typeof value === "string" ? replaceOrigins(value, pairs) : value]));
  const text = /^(?:text\/(?:html|javascript|x-component)|application\/(?:json|javascript|x-javascript))(?:;|$)/i.test(String(outgoing["content-type"]));
  const transform = pairs.length > 0 && text;
  const encoding = outgoing["content-encoding"];
  const decompress = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  if (transform) {
    delete outgoing["content-length"]; delete outgoing.etag; delete outgoing["content-encoding"];
  }
  res.writeHead(response.statusCode ?? 502, { ...outgoing, "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
  if (!transform) { response.pipe(res); return; }
  const done = (error) => { if (error) res.destroy(error); };
  if (decompress) pipeline(response, decompress, originTransform(pairs), res, done);
  else pipeline(response, originTransform(pairs), res, done);
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
  if (!auth?.authorized && !clientMetadata(req, auth)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Open this sandbox from your review launch link. If it has expired, launch a fresh sandbox.");
    return;
  }
  // Clones share fixture credentials internally. The outer private cookie and
  // origin check prevent a page in one clone from using another clone's cookies.
  const allowedOrigins = Object.values(auth.config.origins ?? { app: `https://${req.headers.host}` });
  if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
    res.writeHead(403); res.end("Use this sandbox's own service URLs."); return;
  }
  let destination;
  try { destination = await target(req, auth); }
  catch { res.writeHead(503); res.end("This world is not ready. Try launching again from the review."); return; }
  const inward = originReplacements(auth.config.origins, auth.config.templateOrigins);
  const outward = originReplacements(auth.config.templateOrigins, auth.config.origins);
  const requestHeaders = headers(req, destination.port, inward);
  const rewriteBody = inward.length > 0 && /^(?:\/api\/den)?\/api\/auth\//.test(req.url)
    && String(req.headers["content-type"]).startsWith("application/json");
  if (rewriteBody) delete requestHeaders["content-length"];
  const upstream = request({ ...destination, path: destination.path ?? req.url, method: req.method, headers: requestHeaders }, (response) => relay(response, res, outward));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Sandbox unavailable. Launch a fresh sandbox from the review."); });
  if (rewriteBody) req.pipe(originTransform(inward)).pipe(upstream);
  else req.pipe(upstream);
});

server.on("upgrade", async (req, socket, head) => {
  const auth = await access(req);
  // A cookie alone must not authorize a cross-site WebSocket.
  if (!auth?.authorized || (req.headers.origin && req.headers.origin !== `https://${req.headers.host}`)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  let destination;
  try { destination = await target(req, auth); }
  catch { socket.destroy(); return; }
  const upstream = request({ ...destination, path: destination.path ?? req.url, headers: headers(req, destination.port, originReplacements(auth.config.origins, auth.config.templateOrigins)) });
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
