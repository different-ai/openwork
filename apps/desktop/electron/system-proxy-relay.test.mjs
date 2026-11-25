import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { createSystemProxyRelay, parseProxyRules, splitHostPort, systemProxyRelayEnv } from "./system-proxy-relay.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const sockets = new Set();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      cleanups.push(() => new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }));
      resolve(server.address().port);
    });
  });
}

/** A site that answers every request with what it was asked. */
async function startSite() {
  const server = http.createServer((request, response) => {
    response.end(`site saw ${request.method} ${request.url} auth=${request.headers["proxy-authorization"] ?? "none"}`);
  });
  return listen(server);
}

/** A company proxy that records what it carried. */
async function startCompanyProxy({ refuseWith } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    const url = new URL(request.url);
    const upstream = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: request.method }, (reply) => {
      response.writeHead(reply.statusCode, { "x-via": "company-proxy" });
      reply.pipe(response);
    });
    request.pipe(upstream);
  });
  server.on("connect", (request, client) => {
    seen.push(`CONNECT ${request.url}`);
    if (refuseWith) {
      client.end(`HTTP/1.1 ${refuseWith} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const [host, port] = request.url.split(":");
    const upstream = net.connect({ host, port: Number(port) }, () => {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return { port: await listen(server), seen };
}

async function startRelay(resolveProxy) {
  const logs = [];
  const relay = createSystemProxyRelay({ resolveProxy, log: (line) => logs.push(line) });
  const started = await relay.start();
  cleanups.push(() => relay.stop());
  const url = new URL(started.url);
  const authorization = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`;
  return { ...started, authorization, logs };
}

function get(relay, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: relay.port, path: target, headers: { host: new URL(target).host, ...headers }, agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Opens a tunnel through the relay and sends one plain request down it. */
function tunnelGet(relay, hostPort, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: relay.port, method: "CONNECT", path: hostPort, headers, agent: false });
    request.on("error", reject);
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode, body: "" });
    });
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        resolve({ status: response.statusCode, body: "" });
        return;
      }
      let body = "";
      socket.on("data", (chunk) => (body += chunk));
      socket.on("close", () => resolve({ status: 200, body }));
      socket.write(`GET /through-tunnel HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
    });
    request.end();
  });
}

describe("reading the system proxy answer", () => {
  it("keeps the order and drops kinds it cannot speak", () => {
    assert.deepEqual(parseProxyRules("PROXY proxy.corp.test:8080; SOCKS old:1080; HTTPS secure.corp.test; SOCKS5 s5:1081; DIRECT"), [
      { kind: "http", host: "proxy.corp.test", port: 8080 },
      { kind: "https", host: "secure.corp.test", port: 443 },
      { kind: "socks5", host: "s5", port: 1081 },
      { kind: "direct" },
    ]);
  });

  it("goes direct when there is no usable answer", () => {
    for (const rules of ["", undefined, "DIRECT", "SOCKS only:1080", "garbage"]) {
      assert.deepEqual(parseProxyRules(rules), [{ kind: "direct" }]);
    }
  });

  it("reads IPv6 addresses", () => {
    assert.deepEqual(splitHostPort("[::1]:8080", 80), { host: "::1", port: 8080 });
    assert.deepEqual(splitHostPort("example.test", 443), { host: "example.test", port: 443 });
    assert.equal(splitHostPort("example.test:notaport", 443), null);
  });
});

describe("the environment handed to the engine", () => {
  it("points both spellings at the relay and keeps loopback off it", () => {
    const env = systemProxyRelayEnv("http://openwork:t@127.0.0.1:5000", { NO_PROXY: "intranet.test" });
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      assert.equal(env[name], "http://openwork:t@127.0.0.1:5000");
    }
    assert.equal(env.NO_PROXY, "intranet.test,localhost,127.0.0.1,::1,[::1]");
    assert.equal(env.no_proxy, env.NO_PROXY);
  });

  it("leaves a proxy the person already set alone", () => {
    assert.deepEqual(systemProxyRelayEnv("http://relay", { https_proxy: "http://mine:3128" }), {});
    assert.deepEqual(systemProxyRelayEnv("http://relay", { ALL_PROXY: "socks5://mine:1080" }), {});
  });
});

describe("relay", () => {
  it("connects directly when the system says so", async () => {
    const site = await startSite();
    const asked = [];
    const relay = await startRelay(async (url) => {
      asked.push(url);
      return "DIRECT";
    });
    const plain = await get(relay, `http://127.0.0.1:${site}/plain?x=1`, { "proxy-authorization": relay.authorization });
    assert.equal(plain.status, 200);
    assert.equal(plain.body, "site saw GET /plain?x=1 auth=none");
    const tunneled = await tunnelGet(relay, `127.0.0.1:${site}`, { "proxy-authorization": relay.authorization });
    assert.match(tunneled.body, /site saw GET \/through-tunnel/);
    assert.deepEqual(asked, [`http://127.0.0.1:${site}/plain?x=1`, `https://127.0.0.1:${site}/`]);
  });

  it("sends traffic through the proxy the system names", async () => {
    const site = await startSite();
    const company = await startCompanyProxy();
    const relay = await startRelay(async () => `PROXY 127.0.0.1:${company.port}`);
    const plain = await get(relay, `http://127.0.0.1:${site}/plain`, { "proxy-authorization": relay.authorization });
    assert.equal(plain.headers["x-via"], "company-proxy");
    assert.equal(plain.body, "site saw GET /plain auth=none");
    const tunneled = await tunnelGet(relay, `127.0.0.1:${site}`, { "proxy-authorization": relay.authorization });
    assert.match(tunneled.body, /site saw GET \/through-tunnel/);
    assert.deepEqual(company.seen, [`GET http://127.0.0.1:${site}/plain`, `CONNECT 127.0.0.1:${site}`]);
  });

  it("decides per address, as a PAC script does", async () => {
    const site = await startSite();
    const company = await startCompanyProxy();
    const relay = await startRelay(async (url) => (url.includes("/outside") ? `PROXY 127.0.0.1:${company.port}` : "DIRECT"));
    const headers = { "proxy-authorization": relay.authorization };
    assert.equal((await get(relay, `http://127.0.0.1:${site}/inside`, headers)).headers["x-via"], undefined);
    assert.equal((await get(relay, `http://127.0.0.1:${site}/outside`, headers)).headers["x-via"], "company-proxy");
  });

  it("falls back to the next route when a proxy is unreachable", async () => {
    const site = await startSite();
    const dead = await new Promise((resolve) => {
      const probe = net.createServer().listen({ host: "127.0.0.1", port: 0 }, () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const relay = await startRelay(async () => `PROXY 127.0.0.1:${dead}; DIRECT`);
    const tunneled = await tunnelGet(relay, `127.0.0.1:${site}`, { "proxy-authorization": relay.authorization });
    assert.match(tunneled.body, /site saw GET \/through-tunnel/);
  });

  it("passes on the proxy's refusal instead of going around it", async () => {
    const site = await startSite();
    const company = await startCompanyProxy({ refuseWith: 403 });
    const relay = await startRelay(async () => `PROXY 127.0.0.1:${company.port}; DIRECT`);
    const tunneled = await tunnelGet(relay, `127.0.0.1:${site}`, { "proxy-authorization": relay.authorization });
    assert.equal(tunneled.status, 403);
  });

  it("connects directly when the system proxy settings cannot be read", async () => {
    const site = await startSite();
    const relay = await startRelay(async () => {
      throw new Error("no network service");
    });
    const plain = await get(relay, `http://127.0.0.1:${site}/plain`, { "proxy-authorization": relay.authorization });
    assert.equal(plain.status, 200);
    assert.ok(relay.logs.some((line) => line.includes("connecting directly")));
  });

  it("answers 502 when the site cannot be reached", async () => {
    const relay = await startRelay(async () => "DIRECT");
    const tunneled = await tunnelGet(relay, "127.0.0.1:1", { "proxy-authorization": relay.authorization });
    assert.equal(tunneled.status, 502);
  });

  it("turns away anything that does not know the launch secret", async () => {
    const site = await startSite();
    const asked = [];
    const relay = await startRelay(async (url) => {
      asked.push(url);
      return "DIRECT";
    });
    assert.equal((await get(relay, `http://127.0.0.1:${site}/plain`)).status, 407);
    assert.equal((await get(relay, `http://127.0.0.1:${site}/plain`, { "proxy-authorization": "Basic bm9wZTpub3Bl" })).status, 407);
    assert.equal((await tunnelGet(relay, `127.0.0.1:${site}`)).status, 407);
    assert.deepEqual(asked, []);
  });
});
