import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("preview gateway requires its own token, strips it upstream, rejects cross-site sockets and expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-gateway-"));
  const path = join(directory, "access.json");
  const upstream = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ cookie: req.headers.cookie ?? "", path: req.url, authorization: req.headers.authorization })); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENWORK_PREVIEW_UPSTREAM_PORT = String(address.port);
  process.env.OPENWORK_PREVIEW_GATEWAY_PORT = "0";
  process.env.OPENWORK_PREVIEW_ACCESS_FILE = path;
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
    const status = await new Promise((resolve, reject) => {
      const req = request(origin, { headers: { cookie, origin: "https://unrelated.example", connection: "Upgrade", upgrade: "websocket" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 401);
    await writeFile(path, JSON.stringify({ token: "first-sandbox-token", expiresAt: new Date(Date.now() - 1).toISOString() }));
    assert.equal((await fetch(origin, { headers: { cookie } })).status, 401);
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
