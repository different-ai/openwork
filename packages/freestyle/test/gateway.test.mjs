import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { templateOrigins } from "../src/origins.mjs";

test("preview gateway requires its own token, strips it upstream, rejects cross-site sockets and expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-gateway-"));
  const path = join(directory, "access.json");
  const upstream = createServer(async (req, res) => {
    if (req.url === "/api/auth/origin-test") {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const body = JSON.parse(Buffer.concat(parts).toString());
      assert.ok(body.callbackURL.includes(new URL(templateOrigins.den).hostname));
      assert.ok(req.headers.origin.includes(new URL(templateOrigins.den).hostname));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", location: templateOrigins.den });
      res.end(gzipSync(JSON.stringify({ url: templateOrigins.den, callbackURL: body.callbackURL })));
      return;
    }
    if (req.url === "/oauth/client-metadata.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: `${templateOrigins.den}/oauth/client-metadata.json`, redirect_uris: [`${templateOrigins.den}/v1/mcp-connections/oauth/callback`], cookie: req.headers.cookie ?? "" }));
      return;
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ cookie: req.headers.cookie ?? "", path: req.url, authorization: req.headers.authorization })); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENWORK_PREVIEW_UPSTREAM_PORT = String(address.port);
  process.env.OPENWORK_PREVIEW_GATEWAY_PORT = "0";
  process.env.OPENWORK_PREVIEW_ACCESS_FILE = path;
  process.env.OPENWORK_PREVIEW_SERVICES_FILE = join(directory, "services.json");
  const { server } = await import("../src/gateway.mjs");
  await once(server, "listening");
  const gate = server.address();
  assert.ok(gate && typeof gate !== "string");
  const origin = `http://127.0.0.1:${gate.port}`;
  try {
    assert.equal((await fetch(origin)).status, 401);
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString() }));
    assert.equal((await fetch(`${origin}/__openwork_launch?token=other-sandbox-token`, { redirect: "manual" })).status, 401);
    const launch = await fetch(`${origin}/__openwork_launch?token=first-sandbox-token`, { redirect: "manual" });
    assert.equal(launch.status, 303);
    assert.equal(launch.headers.get("location"), "/");
    assert.match(launch.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
    const cookie = launch.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${origin}/api/openwork/test`, { headers: { cookie: `${cookie}; app=kept`, authorization: "Bearer app-token" } });
    assert.deepEqual(await response.json(), { cookie: "app=kept", path: "/api/openwork/test", authorization: "Bearer app-token" });
    await writeFile(join(directory, "services.json"), JSON.stringify({ app: `http://127.0.0.1:${address.port}`, api: `http://127.0.0.1:${address.port}` }));
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString(), origins: { app: `https://127.0.0.1:${gate.port}` } }));
    const routed = await fetch(`${origin}/api/den/v1/me`, { headers: { cookie } });
    assert.equal((await routed.json()).path, "/v1/me");
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString(), origins: { app: "https://unrelated.example" } }));
    assert.equal((await fetch(origin, { headers: { cookie } })).status, 503);
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString() }));
    assert.equal((await fetch(origin, { headers: { cookie, origin: "https://another-clone.preview.openwork.software" } })).status, 403);
    await writeFile(join(directory, "services.json"), JSON.stringify({ den: `http://127.0.0.1:${address.port}` }));
    const actualDen = `https://127.0.0.1:${gate.port}`;
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString(), origins: { den: actualDen }, templateOrigins }));
    const translated = await fetch(`${origin}/api/auth/origin-test`, {
      method: "POST", headers: { cookie, origin: actualDen, "content-type": "application/json" },
      body: JSON.stringify({ callbackURL: `${actualDen}/dashboard` }),
    });
    assert.equal(translated.status, 200);
    assert.equal(translated.headers.get("content-encoding"), null);
    assert.equal(translated.headers.get("location"), "https://127.0.0.1");
    assert.deepEqual(await translated.json(), { url: "https://127.0.0.1", callbackURL: `${actualDen}/dashboard` });
    // An OAuth provider fetches Den's client metadata itself, without the cookie,
    // and must see this clone's client ID and callback. Only that document is open.
    await writeFile(join(directory, "services.json"), JSON.stringify({ den: "http://127.0.0.1:9", api: `http://127.0.0.1:${address.port}` }));
    const metadata = await fetch(`${origin}/oauth/client-metadata.json`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { client_id: "https://127.0.0.1/oauth/client-metadata.json", redirect_uris: ["https://127.0.0.1/v1/mcp-connections/oauth/callback"], cookie: "" });
    assert.equal((await fetch(`${origin}/oauth/client-metadata.json`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${origin}/v1/mcp-connections/oauth/callback?code=code&state=state`)).status, 401);
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString(), origins: { app: actualDen }, templateOrigins }));
    assert.equal((await fetch(`${origin}/oauth/client-metadata.json`)).status, 401);
    const status = await new Promise((resolve, reject) => {
      const req = request(origin, { headers: { cookie, origin: "https://unrelated.example", connection: "Upgrade", upgrade: "websocket" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 401);
    await writeFile(join(directory, "services.json"), JSON.stringify({ desktop: `http://127.0.0.1:${address.port}` }));
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() + 60000).toISOString(), origins: { desktop: actualDen } }));
    assert.equal((await fetch(`${origin}/vnc.html`)).status, 401);
    assert.equal((await fetch(`${origin}/vnc.html`, { headers: { cookie: "__Host-openwork-preview=another-clone" } })).status, 401);
    const viewer = await fetch(`${origin}/vnc.html`, { headers: { cookie } });
    assert.equal(viewer.status, 200);
    assert.deepEqual(await viewer.json(), { path: "/vnc.html", cookie: "" });
    upstream.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    const viewerSocket = await new Promise((resolve, reject) => {
      const req = request(`${origin}/websockify`, { headers: { cookie, origin: actualDen, connection: "Upgrade", upgrade: "websocket" } });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(viewerSocket, 101);
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() - 1).toISOString() }));
    assert.equal((await fetch(origin, { headers: { cookie } })).status, 401);
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
