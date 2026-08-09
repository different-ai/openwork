import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { denFetch } from "@openwork/behaviors";
import { faultProxy } from "../src/faults.ts";
import type { Server } from "node:http";

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
    proxy.faults.status("/api/den/flaky", 429, { times: 2, body: { error: "slow down" } });

    const first = await fetch(`${proxy.ref.webUrl}/api/den/flaky`);
    const second = await fetch(`${proxy.ref.webUrl}/api/den/flaky`);
    const passed = await fetch(`${proxy.ref.webUrl}/api/den/flaky`);

    assert.equal(first.status, 429);
    assert.deepEqual(await first.json(), { error: "slow down" });
    assert.equal(second.status, 429);
    assert.equal(passed.status, 200);
    assert.equal(passed.headers.get("x-upstream"), "yes");
    assert.deepEqual(await passed.json(), { method: "GET", path: "/api/den/flaky" });

    proxy.faults.latency("/delayed", 25);
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
    proxy.faults.status("/", 500, { times: 3 });
    proxy.faults.clear();

    assert.equal((await fetch(proxy.ref.webUrl)).status, 204);
    assert.equal(proxy.requests[0]?.faulted, false);
  } finally {
    await close(upstream);
  }
});
