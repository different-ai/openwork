import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { denFetch } from "@openwork/behaviors";
import type { Place } from "../src/place.ts";
import { faultProxy } from "../src/faults.ts";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { createConnection } from "node:net";

const websocketKey = "dGhlIHNhbXBsZSBub25jZQ==";
const websocketAccept = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

function upgradeClient(proxyUrl: string, path: string, head = Buffer.alloc(0)): Duplex {
  const proxy = new URL(proxyUrl);
  const socket = createConnection({ host: proxy.hostname, port: Number(proxy.port) });
  // A single write deliberately puts post-handshake bytes in the HTTP parser's head.
  socket.write(Buffer.concat([Buffer.from([
    `GET ${path} HTTP/1.1`,
    `Host: ${proxy.host}`,
    "Connection: keep-alive, Upgrade, x-request-hop",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${websocketKey}`,
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Protocol: test-protocol",
    "Origin: https://browser.example.test",
    "Sec-Fetch-Site: cross-site",
    "Cookie: session=synthetic",
    "Authorization: Bearer synthetic",
    "X-Request-Hop: strip-me",
    "Proxy-Authorization: strip-me",
    "", "",
  ].join("\r\n")), head]));
  return socket;
}

async function readBytes(socket: Duplex, length: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(2_000);
  const chunks: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
    const chunk: unknown = socket.read(Math.min(socket.readableLength, remaining) || remaining);
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      remaining -= chunk.length;
    } else {
      assert(!socket.destroyed && !socket.readableEnded, "socket closed before the expected bytes arrived");
      await once(socket, "readable", { signal });
    }
  }
  return Buffer.concat(chunks);
}

async function readHeaders(socket: Duplex): Promise<string> {
  let headers = "";
  while (!headers.endsWith("\r\n\r\n")) headers += (await readBytes(socket, 1)).toString();
  return headers;
}

function trackSockets(server: Server): Set<Duplex> {
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return sockets;
}

function acceptUpgrade(socket: Duplex, head = Buffer.alloc(0)): void {
  socket.write(Buffer.concat([Buffer.from([
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade, x-response-hop",
    "Upgrade: websocket",
    `Sec-WebSocket-Accept: ${websocketAccept}`,
    "Sec-WebSocket-Protocol: test-protocol",
    "X-Response-Hop: strip-me",
    "Proxy-Authenticate: strip-me",
    "Set-Cookie: first=synthetic",
    "Set-Cookie: second=synthetic",
    "", "",
  ].join("\r\n")), head]));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Upstream test server did not expose a port."));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function absoluteGet(proxyUrl: string, target: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, path: target }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => body += chunk);
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.end();
  });
}

test("faultProxy sends /api/den straight to a split local Den API and keeps the original path in its log", async () => {
  const seen: Array<{ server: string; path: string; authorization: string | undefined }> = [];
  const web = createServer((request, response) => {
    seen.push({ server: "web", path: request.url ?? "", authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "web" }));
  });
  const api = createServer((request, response) => {
    seen.push({ server: "api", path: request.url ?? "", authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "api" }));
  });
  const webPort = await listen(web);
  const apiPort = await listen(api);
  try {
    await using proxy = await faultProxy({
      apiUrl: `http://127.0.0.1:${apiPort}`,
      webUrl: `http://127.0.0.1:${webPort}`,
    });
    // den-web would answer this with a cross-origin 307 that drops the bearer;
    // the proxy hands it to den-api directly, prefix stripped, header intact.
    const handoff = await fetch(`${proxy.ref.webUrl}/api/den/v1/auth/desktop-handoff?scheme=openwork`, {
      method: "POST",
      headers: { authorization: "Bearer member-session" },
    });
    assert.deepEqual(await handoff.json(), { server: "api" });
    const page = await fetch(`${proxy.ref.webUrl}/api/runtime-config`);
    assert.deepEqual(await page.json(), { server: "web" });
    assert.deepEqual(seen, [
      { server: "api", path: "/v1/auth/desktop-handoff?scheme=openwork", authorization: "Bearer member-session" },
      { server: "web", path: "/api/runtime-config", authorization: undefined },
    ]);
    assert.deepEqual(proxy.requests.map(({ path }) => path), ["/api/den/v1/auth/desktop-handoff?scheme=openwork", "/api/runtime-config"]);
  } finally {
    web.close();
    api.close();
  }
});

test("faultProxy consumes status and latency rules before passing through", async () => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
    response.end(JSON.stringify({ method: request.method, path: request.url }));
  });
  const port = await listen(upstream);
  try {
    await using proxy = await faultProxy({
      apiUrl: `http://127.0.0.1:${port}`,
      webUrl: `http://127.0.0.1:${port}`,
    });
    await proxy.faults.status("/api/den/flaky", 429, { times: 2, body: { error: "slow down" } });

    const first = await fetch(`${proxy.ref.webUrl}/api/den/flaky`);
    const second = await fetch(`${proxy.ref.webUrl}/api/den/flaky`);
    const passed = await fetch(`${proxy.ref.webUrl}/api/den/flaky`);

    assert.equal(first.status, 429);
    assert.deepEqual(await first.json(), { error: "slow down" });
    assert.equal(second.status, 429);
    assert.equal(passed.status, 200);
    assert.equal(passed.headers.get("x-upstream"), "yes");
    assert.deepEqual(await passed.json(), { method: "GET", path: "/api/den/flaky" });

    await proxy.faults.latency("/delayed", 25);
    const startedAt = Date.now();
    const delayed = await fetch(`${proxy.ref.webUrl}/delayed`);
    assert.equal(delayed.status, 200);
    assert(Date.now() - startedAt >= 15);
    assert.equal((await fetch(`${proxy.ref.webUrl}/delayed`)).status, 200);
    const behaviorResult = await denFetch(proxy.ref, "/behavior");
    assert.equal(behaviorResult.response.status, 200);
    assert.deepEqual(behaviorResult.body, { method: "GET", path: "/api/den/behavior" });

    assert.deepEqual(
      proxy.requests.map(({ path, status, faulted }) => ({ path, status, faulted })),
      [
        { path: "/api/den/flaky", status: 429, faulted: true },
        { path: "/api/den/flaky", status: 429, faulted: true },
        { path: "/api/den/flaky", status: 200, faulted: false },
        { path: "/delayed", status: 200, faulted: true },
        { path: "/delayed", status: 200, faulted: false },
        { path: "/api/den/behavior", status: 200, faulted: false },
      ],
    );
    assert.deepEqual(await proxy.requestLog(), proxy.requests);
    assert.notEqual(await proxy.requestLog(), proxy.requests);
  } finally {
    await close(upstream);
  }
});

test("faultProxy clear removes pending rules", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const port = await listen(upstream);
  try {
    await using proxy = await faultProxy({
      apiUrl: `http://127.0.0.1:${port}`,
      webUrl: `http://127.0.0.1:${port}`,
    });
    await proxy.faults.status("/", 500, { times: 3 });
    await proxy.faults.clear();

    assert.equal((await fetch(proxy.ref.webUrl)).status, 204);
    assert.equal(proxy.requests[0]?.faulted, false);
  } finally {
    await close(upstream);
  }
});

test("faultProxy requires the Den sandbox id for Daytona placement", async () => {
  const place: Place = {
    kind: "daytona",
    host: () => undefined,
    db: async () => { throw new Error("unused"); },
    exposeMock: async () => { throw new Error("unused"); },
    denBase: () => ({ kind: "daytona", ref: "dev" }),
  };

  await assert.rejects(
    faultProxy(
      { apiUrl: "https://den-api.example.test", webUrl: "https://den.example.test" },
      { place, sandbox: undefined },
    ),
    /fault proxy on Daytona needs the Den sandbox id; pass `sandbox: den\.placement\.sandboxId`/,
  );
});

test("faultProxy relays WebSocket headers and byte heads in both directions, then disposes both sockets", async () => {
  const seen: IncomingMessage[] = [];
  const greeting = Buffer.from([0x82, 0x02, 0x00, 0xff]);
  const clientHead = Buffer.from([0x82, 0x82, 0x01, 0x02, 0x03, 0x04, 0xfe, 0x02]);
  const upstream = createServer((_request, response) => { response.writeHead(404).end(); });
  const peers = trackSockets(upstream);
  upstream.on("upgrade", (request, socket, head) => {
    seen.push(request);
    acceptUpgrade(socket, greeting);
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  const port = await listen(upstream);
  const proxy = await faultProxy({ apiUrl: `http://127.0.0.1:${port}`, webUrl: `http://127.0.0.1:${port}` });
  const path = "/_next/hmr?token=synthetic%2Ftoken&v=1";
  const client = upgradeClient(proxy.ref.webUrl, path, clientHead);
  try {
    const headers = await readHeaders(client);
    assert.match(headers, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(headers, /\r\nconnection: Upgrade\r\n/i);
    assert.match(headers, /\r\nupgrade: websocket\r\n/i);
    assert.match(headers, new RegExp(`\\r\\nsec-websocket-accept: ${websocketAccept.replaceAll("+", "\\+")}\\r\\n`, "i"));
    assert.match(headers, /\r\nsec-websocket-protocol: test-protocol\r\n/i);
    assert.match(headers, /\r\nset-cookie: first=synthetic\r\n/i);
    assert.match(headers, /\r\nset-cookie: second=synthetic\r\n/i);
    assert.doesNotMatch(headers, /x-response-hop|proxy-authenticate/i);
    assert.deepEqual(await readBytes(client, greeting.length + clientHead.length), Buffer.concat([greeting, clientHead]));

    const later = Buffer.from([0x82, 0x81, 0x01, 0x02, 0x03, 0x04, 0x80]);
    client.write(later);
    assert.deepEqual(await readBytes(client, later.length), later);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, path);
    assert.equal(seen[0]?.headers.host, `127.0.0.1:${port}`);
    assert.equal(seen[0]?.headers.connection?.toLowerCase(), "upgrade");
    assert.equal(seen[0]?.headers.upgrade, "websocket");
    assert.equal(seen[0]?.headers.origin, "https://browser.example.test");
    assert.equal(seen[0]?.headers["sec-fetch-site"], "cross-site");
    assert.equal(seen[0]?.headers["sec-websocket-key"], websocketKey);
    assert.equal(seen[0]?.headers["sec-websocket-version"], "13");
    assert.equal(seen[0]?.headers["sec-websocket-protocol"], "test-protocol");
    assert.equal(seen[0]?.headers.cookie, "session=synthetic");
    assert.equal(seen[0]?.headers.authorization, "Bearer synthetic");
    assert.equal(seen[0]?.headers["x-request-hop"], undefined);
    assert.equal(seen[0]?.headers["proxy-authorization"], undefined);
    assert.deepEqual(proxy.requests.map(({ path, status, faulted }) => ({ path, status, faulted })), [
      { path, status: 101, faulted: false },
    ]);

    const closed = [client, ...peers].map((socket) => once(socket, "close", { signal: AbortSignal.timeout(2_000) }));
    client.resume();
    await Promise.all([proxy[Symbol.asyncDispose](), ...closed]);
    await proxy[Symbol.asyncDispose]();
  } finally {
    client.destroy();
    for (const socket of peers) socket.destroy();
    await proxy[Symbol.asyncDispose]();
    await close(upstream);
  }
});

test("faultProxy pins absolute-form WebSocket targets to the web upstream, not the API or attacker", async () => {
  let attackerRequests = 0;
  let apiRequests = 0;
  let upstreamRequestUrl: string | undefined;
  const upstream = createServer((_request, response) => { response.writeHead(404).end(); });
  const peers = trackSockets(upstream);
  upstream.on("upgrade", (request, socket) => {
    upstreamRequestUrl = request.url;
    acceptUpgrade(socket);
  });
  const attacker = createServer((_request, response) => { attackerRequests += 1; response.end(); });
  attacker.on("upgrade", (_request, socket) => { attackerRequests += 1; socket.destroy(); });
  const api = createServer((_request, response) => { apiRequests += 1; response.end(); });
  api.on("upgrade", (_request, socket) => { apiRequests += 1; socket.destroy(); });
  const [port, attackerPort, apiPort] = await Promise.all([listen(upstream), listen(attacker), listen(api)]);
  const proxy = await faultProxy({ apiUrl: `http://127.0.0.1:${apiPort}`, webUrl: `http://127.0.0.1:${port}` });
  const client = upgradeClient(proxy.ref.webUrl, `http://127.0.0.1:${attackerPort}/api/den/steered?x=1`);
  try {
    assert.match(await readHeaders(client), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.equal(upstreamRequestUrl, "/api/den/steered?x=1");
    assert.equal(attackerRequests, 0);
    assert.equal(apiRequests, 0);
  } finally {
    client.destroy();
    for (const socket of peers) socket.destroy();
    await proxy[Symbol.asyncDispose]();
    await Promise.all([close(upstream), close(attacker), close(api)]);
  }
});

for (const disconnect of ["dispose", "client"]) {
  test(`faultProxy cancels pending WebSocket handshakes on ${disconnect} disconnect`, async () => {
    const upstream = createServer((_request, response) => { response.writeHead(404).end(); });
    const peers = trackSockets(upstream);
    upstream.on("upgrade", (_request, socket) => {
      socket.resume();
      socket.on("end", () => socket.end());
    });
    const port = await listen(upstream);
    const proxy = await faultProxy({ apiUrl: `http://127.0.0.1:${port}`, webUrl: `http://127.0.0.1:${port}` });
    const reachedUpstream = once(upstream, "upgrade", { signal: AbortSignal.timeout(2_000) });
    const client = upgradeClient(proxy.ref.webUrl, "/_next/hmr?pending=1");
    client.resume();
    try {
      await reachedUpstream;
      const closed = [client, ...peers].map((socket) => once(socket, "close", { signal: AbortSignal.timeout(2_000) }));
      if (disconnect === "client") client.destroy();
      await Promise.all([...(disconnect === "dispose" ? [proxy[Symbol.asyncDispose]()] : []), ...closed]);
      assert.deepEqual(await proxy.requestLog(), []);
    } finally {
      client.destroy();
      for (const socket of peers) socket.destroy();
      await proxy[Symbol.asyncDispose]();
      await close(upstream);
    }
  });
}

test("faultProxy preserves upstream origin rejection instead of manufacturing a WebSocket upgrade", async () => {
  const upstream = createServer((_request, response) => { response.writeHead(404).end(); });
  const peers = trackSockets(upstream);
  let origin: string | undefined;
  upstream.on("upgrade", (request, socket) => {
    origin = request.headers.origin;
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close, x-response-hop\r\nX-Response-Hop: strip-me\r\nContent-Length: 6\r\n\r\ndenied");
  });
  const port = await listen(upstream);
  const proxy = await faultProxy({ apiUrl: `http://127.0.0.1:${port}`, webUrl: `http://127.0.0.1:${port}` });
  const client = upgradeClient(proxy.ref.webUrl, "/_next/hmr");
  try {
    const headers = await readHeaders(client);
    assert.match(headers, /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.doesNotMatch(headers, /x-response-hop|upgrade:/i);
    assert.equal((await readBytes(client, 6)).toString(), "denied");
    assert.equal(origin, "https://browser.example.test");
    assert.equal(proxy.requests[0]?.status, 403);
  } finally {
    client.destroy();
    for (const socket of peers) socket.destroy();
    await proxy[Symbol.asyncDispose]();
    await close(upstream);
  }
});

test("faultProxy keeps hop-by-hop headers out of ordinary HTTP requests and responses", async () => {
  const seen: IncomingMessage[] = [];
  const upstream = createServer((request, response) => {
    seen.push(request);
    response.writeHead(200, { connection: "close, x-response-hop", "x-response-hop": "strip-me", "x-end-to-end": "keep-me" });
    response.end("ok");
  });
  const port = await listen(upstream);
  try {
    await using proxy = await faultProxy({ apiUrl: `http://127.0.0.1:${port}`, webUrl: `http://127.0.0.1:${port}` });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(proxy.ref.webUrl, {
        headers: { connection: "close, x-request-hop", "x-request-hop": "strip-me", "x-end-to-end": "keep-me" },
      }, resolve);
      request.on("error", reject);
      request.end();
    });
    response.resume();
    await once(response, "end");
    assert.equal(response.statusCode, 200);
    assert.equal(seen[0]?.headers["x-request-hop"], undefined);
    assert.equal(seen[0]?.headers["x-end-to-end"], "keep-me");
    assert.equal(response.headers["x-response-hop"], undefined);
    assert.equal(response.headers["x-end-to-end"], "keep-me");
    assert.equal(response.headers.upgrade, undefined);
  } finally {
    await close(upstream);
  }
});

test("faultProxy pins absolute-form request targets to its upstream", async () => {
  let attackerRequests = 0;
  let upstreamRequestUrl: string | undefined;
  const upstream = createServer((request, response) => {
    upstreamRequestUrl = request.url;
    response.end("upstream");
  });
  const attacker = createServer((_request, response) => {
    attackerRequests += 1;
    response.end("attacker");
  });
  const [upstreamPort, attackerPort] = await Promise.all([listen(upstream), listen(attacker)]);
  try {
    await using proxy = await faultProxy({
      apiUrl: `http://127.0.0.1:${upstreamPort}`,
      webUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    assert.equal(
      await absoluteGet(proxy.ref.webUrl, `http://127.0.0.1:${attackerPort}/steered?x=1`),
      "upstream",
    );
    assert.equal(upstreamRequestUrl, "/steered?x=1");
    assert.equal(attackerRequests, 0);
  } finally {
    await Promise.all([close(upstream), close(attacker)]);
  }
});
