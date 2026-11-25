import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/**
 * A forward proxy on loopback that sends each request the way the system
 * proxy settings say to. The window already follows those settings (fixed
 * proxy, PAC script, auto-detect) through Chromium; the engine and the tools
 * it runs only understand a proxy address in the environment. Pointing them
 * here gives them the same route as the window, decided per request.
 */

const RESOLVE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 30_000;
const RELAY_USER = "openwork";
const HOP_BY_HOP = ["proxy-authorization", "proxy-connection"];
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** @typedef {{ kind: "direct" | "http" | "https" | "socks5", host?: string, port?: number }} Route */

/**
 * Turns Chromium's answer ("PROXY a:8080; DIRECT") into routes to try in order.
 * Kinds this relay cannot speak are dropped; an empty answer means direct.
 * @returns {Route[]}
 */
export function parseProxyRules(rules) {
  /** @type {Route[]} */
  const routes = [];
  for (const entry of String(rules ?? "").split(";")) {
    const [kindRaw, address] = entry.trim().split(/\s+/);
    const kind = (kindRaw ?? "").toUpperCase();
    if (kind === "DIRECT") {
      routes.push({ kind: "direct" });
      continue;
    }
    const target = splitHostPort(address ?? "", kind === "HTTPS" ? 443 : kind.startsWith("SOCKS") ? 1080 : 80);
    if (!target) continue;
    if (kind === "PROXY" || kind === "HTTP") routes.push({ kind: "http", ...target });
    else if (kind === "HTTPS") routes.push({ kind: "https", ...target });
    else if (kind === "SOCKS5") routes.push({ kind: "socks5", ...target });
  }
  return routes.length ? routes : [{ kind: "direct" }];
}

/** "host:port", "[::1]:port" or a bare host, as `{ host, port }`. */
export function splitHostPort(value, defaultPort) {
  const text = value.trim();
  if (!text) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
  const colon = text.lastIndexOf(":");
  if (colon === -1 || text.indexOf(":") !== colon) return { host: text, port: defaultPort };
  const port = Number(text.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: text.slice(0, colon), port };
}

function hostHeader(host, port) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * The environment that points a child process at the relay, or nothing when
 * the person or their IT already set a proxy address: an explicit setting wins.
 */
export function systemProxyRelayEnv(relayUrl, env = process.env) {
  if (PROXY_ENV.some((name) => env[name]?.trim())) return {};
  const existing = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const noProxy = [...existing, ...LOOPBACK_NO_PROXY.filter((host) => !existing.includes(host))].join(",");
  return {
    HTTP_PROXY: relayUrl,
    HTTPS_PROXY: relayUrl,
    http_proxy: relayUrl,
    https_proxy: relayUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function openSocket(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error(`Timed out connecting to ${host}:${port}`)));
    socket.once("error", fail);
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.setTimeout(0);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

/** Reads from `socket` until `done(buffer)` returns a value, then hands back that value. */
function readUntil(socket, done) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => onEnd(new Error("The proxy did not answer in time.")), CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onEnd);
      socket.removeListener("close", onClose);
    };
    const onEnd = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onEnd(new Error("The proxy closed the connection."));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let result;
      try {
        result = done(buffer);
      } catch (error) {
        onEnd(error);
        return;
      }
      if (result === undefined) return;
      cleanup();
      socket.pause();
      resolve(result);
    };
    socket.on("data", onData);
    socket.once("error", onEnd);
    socket.once("close", onClose);
  });
}

class UpstreamRefused extends Error {
  constructor(status, head) {
    super(`The proxy answered ${status}`);
    this.status = status;
    this.head = head;
  }
}

async function tunnelThroughHttpProxy(route, host, port, proxyAuthorization) {
  const socket = await openSocket(route.host, route.port, route.kind === "https");
  const target = hostHeader(host, port);
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${proxyAuthorization ? `Proxy-Authorization: ${proxyAuthorization}\r\n` : ""}\r\n`,
  );
  try {
    const rest = await readUntil(socket, (buffer) => {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > 64 * 1024) throw new Error("The proxy sent an oversized reply.");
        return undefined;
      }
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(buffer.toString("latin1", 0, end))?.[1]);
      if (status >= 200 && status < 300) return buffer.subarray(end + 4);
      throw new UpstreamRefused(status || 502, buffer);
    });
    if (rest.length) socket.unshift(rest);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function tunnelThroughSocks5(route, host, port) {
  const socket = await openSocket(route.host, route.port, false);
  try {
    socket.write(Buffer.from([5, 1, 0]));
    await readUntil(socket, (buffer) => {
      if (buffer.length < 2) return undefined;
      if (buffer[0] !== 5 || buffer[1] !== 0) throw new Error("The SOCKS proxy needs a sign-in this app cannot give.");
      return true;
    });
    socket.resume();
    const name = Buffer.from(host, "utf8");
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
    const rest = await readUntil(socket, (buffer) => {
      if (buffer.length < 5) return undefined;
      if (buffer[1] !== 0) throw new Error(`The SOCKS proxy refused the connection (${buffer[1]}).`);
      const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : 7 + buffer[4];
      return buffer.length >= length ? buffer.subarray(length) : undefined;
    });
    if (rest.length) socket.unshift(rest);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * @param {{ resolveProxy: (url: string) => Promise<string>, log?: (message: string) => void }} options
 */
export function createSystemProxyRelay({ resolveProxy, log = () => {} }) {
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${RELAY_USER}:${token}`).toString("base64")}`);
  const sockets = new Set();
  let routedKinds = "";

  // Only processes this app started know the token, so another account on a
  // shared computer cannot send its traffic out as this person.
  const authorized = (headers) => {
    const given = Buffer.from(String(headers["proxy-authorization"] ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  /** @returns {Promise<Route[]>} */
  const routesFor = async (url) => {
    let timer;
    try {
      const rules = await Promise.race([
        resolveProxy(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out reading the system proxy settings")), RESOLVE_TIMEOUT_MS);
        }),
      ]);
      const routes = parseProxyRules(rules);
      const kinds = routes.map((route) => route.kind).join(",");
      if (kinds !== routedKinds) {
        routedKinds = kinds;
        log(`[system-proxy] routing through: ${kinds}`);
      }
      return routes;
    } catch (error) {
      log(`[system-proxy] ${error instanceof Error ? error.message : String(error)}; connecting directly`);
      return [{ kind: "direct" }];
    } finally {
      clearTimeout(timer);
    }
  };

  /** A raw connection to host:port by the first route that works. */
  const tunnel = async (scheme, host, port) => {
    const routes = await routesFor(`${scheme}://${hostHeader(host, port)}/`);
    let lastError = new Error("No usable route.");
    for (const route of routes) {
      try {
        if (route.kind === "direct") return await openSocket(host, port, false);
        if (route.kind === "socks5") return await tunnelThroughSocks5(route, host, port);
        return await tunnelThroughHttpProxy(route, host, port);
      } catch (error) {
        lastError = error;
        if (error instanceof UpstreamRefused) break;
      }
    }
    throw lastError;
  };

  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const join = (a, b) => {
    a.on("error", () => b.destroy());
    b.on("error", () => a.destroy());
    a.on("close", () => b.destroy());
    b.on("close", () => a.destroy());
    a.pipe(b);
    b.pipe(a);
  };

  const refuse = (socket, status, reason, extraHeaders = "") => {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extraHeaders}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  };

  const requireAuth = 'Proxy-Authenticate: Basic realm="OpenWork"\r\n';

  const forwardedHeaders = (headers) => {
    const next = { ...headers };
    for (const name of HOP_BY_HOP) delete next[name];
    return next;
  };

  const server = http.createServer();

  // HTTPS, and anything else that asks for a raw connection.
  server.on("connect", (request, client, head) => {
    track(client);
    client.on("error", () => {});
    if (!authorized(request.headers)) return refuse(client, 407, "Proxy Authentication Required", requireAuth);
    const target = splitHostPort(request.url ?? "", 443);
    if (!target) return refuse(client, 400, "Bad Request");
    tunnel(target.port === 80 ? "http" : "https", target.host, target.port).then(
      (upstream) => {
        track(upstream);
        if (client.destroyed) return upstream.destroy();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        join(client, upstream);
        upstream.resume();
      },
      (error) => {
        if (error instanceof UpstreamRefused) {
          if (!client.destroyed) client.end(error.head);
          return;
        }
        log(`[system-proxy] could not reach ${target.host}:${target.port}: ${error?.message ?? error}`);
        refuse(client, 502, "Bad Gateway");
      },
    );
  });

  /** Where a plain http request goes: straight to the site, or to a proxy that takes the full address. */
  const plainRoute = async (url) => {
    const port = Number(url.port) || 80;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const routes = await routesFor(url.href);
    const route = routes[0];
    if (route.kind === "http" || route.kind === "https") return { route, host, port, path: url.href, viaProxy: true };
    return { route, host, port, path: `${url.pathname}${url.search}`, viaProxy: false };
  };

  const plainUrl = (request) => {
    try {
      const url = new URL(request.url ?? "");
      return url.protocol === "http:" ? url : null;
    } catch {
      return null;
    }
  };

  server.on("request", (request, response) => {
    if (!authorized(request.headers)) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="OpenWork"', "Content-Length": "0" });
      response.end();
      return;
    }
    const url = plainUrl(request);
    if (!url) {
      response.writeHead(400, { "Content-Length": "0" });
      response.end();
      return;
    }
    const fail = (error) => {
      log(`[system-proxy] could not reach ${url.host}: ${error?.message ?? error}`);
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "Content-Length": "0" });
        response.end();
      }
    };
    plainRoute(url).then(async ({ route, host, port, path, viaProxy }) => {
      const createConnection = route.kind === "socks5"
        ? await tunnelThroughSocks5(route, host, port).then((socket) => () => socket)
        : undefined;
      const upstream = (route.kind === "https" ? httpsRequest : http.request)({
        host: viaProxy ? route.host : host,
        port: viaProxy ? route.port : port,
        method: request.method,
        path,
        headers: forwardedHeaders(request.headers),
        agent: false,
        createConnection,
        timeout: CONNECT_TIMEOUT_MS,
      });
      upstream.on("timeout", () => upstream.destroy(new Error("Timed out")));
      upstream.on("error", fail);
      upstream.on("response", (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.headers);
        reply.pipe(response);
        reply.on("error", () => response.destroy());
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    }).catch(fail);
  });

  // WebSocket over plain http: replay the request on a raw connection.
  server.on("upgrade", (request, client, head) => {
    track(client);
    client.on("error", () => {});
    if (!authorized(request.headers)) return refuse(client, 407, "Proxy Authentication Required", requireAuth);
    const url = plainUrl(request);
    if (!url) return refuse(client, 400, "Bad Request");
    plainRoute(url).then(async ({ route, host, port, path, viaProxy }) => {
      const upstream = track(
        route.kind === "socks5"
          ? await tunnelThroughSocks5(route, host, port)
          : await openSocket(viaProxy ? route.host : host, viaProxy ? route.port : port, route.kind === "https"),
      );
      if (client.destroyed) return upstream.destroy();
      const lines = [`${request.method} ${path} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (HOP_BY_HOP.includes(request.rawHeaders[index].toLowerCase())) continue;
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      join(client, upstream);
      upstream.resume();
    }).catch((error) => {
      log(`[system-proxy] could not reach ${url.host}: ${error?.message ?? error}`);
      refuse(client, 502, "Bad Gateway");
    });
  });

  server.on("connection", (socket) => track(socket));
  server.on("clientError", (_error, socket) => socket.destroy());

  return {
    /** Starts listening on loopback and returns the address children should use. */
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
          server.removeListener("error", reject);
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          resolve({ port, url: `http://${RELAY_USER}:${token}@127.0.0.1:${port}` });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve(undefined));
      });
    },
  };
}

function httpsRequest(options) {
  const { createConnection: _unused, ...rest } = options;
  return http.request({
    ...rest,
    createConnection: () => tls.connect({ host: rest.host, port: rest.port, servername: net.isIP(rest.host) ? undefined : rest.host }),
  });
}
