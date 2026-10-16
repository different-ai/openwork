import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

export interface LocalEndpoint {
  /** `http://127.0.0.1:<port>`: what every local client connects to. */
  url: string;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Set when the relay itself could not reach the remote, so callers can tell it from a remote 502. */
export const RELAY_UNREACHABLE_HEADER = "x-openwork-relay-unreachable";

/** Diagnostic response headers worth keeping; nothing that can carry a credential. */
const DIAGNOSTIC_HEADERS = ["x-request-id", "server", "via", "cf-ray"];

function upstreamOf(remote: URL) {
  if (remote.protocol === "https:") return { request: httpsRequest, port: Number(remote.port || 443) };
  // Plain HTTP only to this machine's own loopback (the near end of an SSH forward).
  if (remote.protocol === "http:" && remote.hostname === "127.0.0.1") return { request: httpRequest, port: Number(remote.port || 80) };
  throw new Error("Remote sandbox ports must use HTTPS");
}

function diagnostics(headers: IncomingHttpHeaders) {
  const kept: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") kept[name] = value;
  }
  return kept;
}

/**
 * Loopback relay to a remote sandbox port. Access headers (a gateway cookie, a
 * provider token) are added here, so they never appear in URLs, CDP target
 * lists, surfaces or evidence logs. WebSocket upgrades are relayed too.
 */
export async function loopbackRelay(remote: URL, access: Record<string, string> = {}): Promise<LocalEndpoint> {
  const upstream = upstreamOf(remote);
  const peers = new Set<Duplex>();
  const target = { hostname: remote.hostname, port: upstream.port };
  const server = createServer((req, res) => {
    // This loopback endpoint is for a local controller, not arbitrary websites.
    if (req.headers.origin || req.headers["sec-fetch-site"]) { res.writeHead(403).end(); return; }
    const outgoing = upstream.request({ ...target, path: req.url, method: req.method,
      headers: { ...access, host: remote.host, "content-type": "application/json" }, timeout: 30_000 }, (response) => {
      res.writeHead(response.statusCode ?? 502, { ...diagnostics(response.headers), "content-type": "application/json", "cache-control": "no-store" });
      response.pipe(res);
    });
    outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502, { [RELAY_UNREACHABLE_HEADER]: "1" }); res.end(); });
    outgoing.on("timeout", () => outgoing.destroy());
    req.pipe(outgoing);
  });
  server.on("connection", (socket) => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.origin || req.headers["sec-fetch-site"]) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const outgoing = upstream.request({ ...target, path: req.url, headers: { ...req.headers, ...access, host: remote.host } });
    outgoing.on("upgrade", (response, peer, upstreamHead) => {
      peers.add(peer); peer.on("close", () => peers.delete(peer));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(peer).pipe(socket);
      peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy());
    });
    outgoing.on("response", () => socket.destroy());
    outgoing.on("error", () => socket.destroy());
    outgoing.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sandbox relay did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      for (const peer of peers) peer.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
