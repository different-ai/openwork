import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FAULT_PROXY_SCRIPT } from "../src/fault-proxy-script.ts";
import type { Server } from "node:http";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Test server did not expose a port."));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test("fault proxy script exposes authenticated controls and preserves local fault semantics", async () => {
  let webApiRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url?.startsWith("/api/den/")) {
      webApiRequests++;
      response.writeHead(307, { location: "https://redirect.invalid/v1/me" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
  });
  const upstreamPort = await listen(upstream);
  const api = createServer((request, response) => {
    assert.equal(request.url, "/v1/me");
    const signedIn = request.headers.authorization === "Bearer fixture-session";
    response.writeHead(signedIn ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(signedIn ? { user: { id: "member", email: "member@openwork.test" } } : { error: "unauthorized" }));
  });
  const apiPort = await listen(api);
  const proxyPort = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "openwork-fault-proxy-"));
  const scriptPath = join(directory, "proxy.mjs");
  await writeFile(scriptPath, FAULT_PROXY_SCRIPT);
  const issuer = "https://fault-proxy.example.test";
  const token = "test-control-token";
  const child = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      API_UPSTREAM: `http://127.0.0.1:${apiPort}`,
      ISSUER: issuer,
      CONTROL_TOKEN: token,
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${proxyPort}`;
  const auth = { "x-openwork-fault-token": token };
  const post = (path: string, body?: unknown): Promise<Response> => fetch(`${url}${path}`, {
    method: "POST",
    headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  try {
    const deadline = Date.now() + 5_000;
    let health: Response | undefined;
    while (Date.now() < deadline) {
      try {
        health = await fetch(`${url}/__openwork_faults/health`);
        if (health.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert(health?.ok, "fault proxy health did not become ready");
    assert.deepEqual(await health.json(), { ok: true, issuer });
    assert.equal((await fetch(`${url}/__openwork_faults/requests`)).status, 401);
    assert.equal((await fetch(`${url}/__openwork_faults/clear`, { method: "POST" })).status, 401);
    assert.equal((await post("/__openwork_faults/rules", {
      kind: "status",
      pathPrefix: "/flaky",
      statusCode: 429,
      times: 2,
      body: { error: "injected" },
    })).status, 204);

    assert.equal((await fetch(`${url}/flaky/one`)).status, 429);
    assert.equal((await fetch(`${url}/flaky/two`)).status, 429);
    assert.equal((await fetch(`${url}/flaky/three`)).status, 200);

    assert.equal((await post("/__openwork_faults/rules", {
      kind: "latency",
      pathPrefix: "/slow",
      delayMs: 30,
    })).status, 204);
    const startedAt = Date.now();
    assert.equal((await fetch(`${url}/slow`)).status, 200);
    assert(Date.now() - startedAt >= 20);

    assert.equal((await post("/__openwork_faults/rules", {
      kind: "status",
      pathPrefix: "/cleared",
      statusCode: 500,
      times: 3,
    })).status, 204);
    assert.equal((await post("/__openwork_faults/clear")).status, 204);
    assert.equal((await fetch(`${url}/cleared`)).status, 200);

    const logResponse = await fetch(`${url}/__openwork_faults/requests`, { headers: auth });
    assert.equal(logResponse.status, 200);
    const log: unknown = await logResponse.json();
    assert.deepEqual(
      typeof log === "object" && log !== null && "requests" in log && Array.isArray(log.requests)
        ? log.requests.map((entry) => ({ path: entry.path, status: entry.status, faulted: entry.faulted }))
        : log,
      [
        { path: "/flaky/one", status: 429, faulted: true },
        { path: "/flaky/two", status: 429, faulted: true },
        { path: "/flaky/three", status: 200, faulted: false },
        { path: "/slow", status: 200, faulted: true },
        { path: "/cleared", status: 200, faulted: false },
      ],
    );
    const signedOut = await fetch(`${url}/api/den/v1/me`, { redirect: "error" });
    assert.equal(signedOut.status, 401);
    assert.deepEqual(await signedOut.json(), { error: "unauthorized" });
    const signedIn = await fetch(`${url}/api/den/v1/me`, { redirect: "error", headers: { Authorization: "Bearer fixture-session" } });
    assert.equal(signedIn.status, 200);
    assert.deepEqual(await signedIn.json(), { user: { id: "member", email: "member@openwork.test" } });
    assert.equal(webApiRequests, 0, "API verification must not pass through Den Web's redirect route");
  } finally {
    child.kill("SIGTERM");
    await close(upstream);
    await close(api);
    await rm(directory, { recursive: true, force: true });
  }
});
