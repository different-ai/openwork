import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { fetchFiniteDesktopHttp } from "./finite-http-fetch.mjs";
import { createDesktopTransferRegistry } from "./binary-transfer.mjs";

async function mainFetchHandler(desktopTransfers, fetcher = fetchFiniteDesktopHttp) {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const match = source.match(/"__fetch": (async \(event, \.\.\.args\) => \{[\s\S]*?\n  \}),\n  "__uploadMultipart"/);
  assert.ok(match, "Main finite-fetch handler must be exercised, not a copied cancellation policy");
  return runInNewContext(`(${match[1]})`, {
    fetchFiniteDesktopHttp: fetcher, electronNet: { fetch: noExternal }, desktopTransfers, URL, AbortSignal,
  });
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
const noExternal = () => { throw new Error("Loopback must not use Chromium"); };

test("finite loopback GET and PATCH preserve authentication, directory, body and HTTP error without retries", async () => {
  const requests = [];
  const server = await listen((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(request.method === "PATCH" ? 409 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method }));
    });
  });
  try {
    const headers = { Authorization: "Bearer fixture-only", "x-opencode-directory": "/fixture/a", "Content-Type": "application/json" };
    const get = await fetchFiniteDesktopHttp(`${server.url}/session/fixture`, { headers }, noExternal);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { method: "GET" });
    const body = JSON.stringify({ time: { archived: 123 } });
    const patch = await fetchFiniteDesktopHttp(`${server.url}/session/fixture`, { method: "PATCH", headers, body }, noExternal);
    assert.equal(patch.status, 409);
    assert.deepEqual(await patch.json(), { method: "PATCH" });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body, body);
    for (const request of requests) {
      assert.equal(request.url, "/session/fixture");
      assert.equal(request.headers.authorization, headers.Authorization);
      assert.equal(request.headers["x-opencode-directory"], "/fixture/a");
    }
  } finally { await server.close(); }
});

test("main permission replies preserve once/always/reject bodies and HTTP failures without replay", async () => {
  const requests = [];
  const server = await listen((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(body.includes("reject") ? 409 : 200, { "content-type": "application/json" });
      response.end("true");
    });
  });
  const registry = createDesktopTransferRegistry();
  const handler = await mainFetchHandler(registry);
  const owner = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
  try {
    for (const reply of ["once", "always", "reject"]) {
      const body = JSON.stringify({ reply });
      const path = "/proxy/workspace/ws_fixture/opencode/permission/per_fixture/reply?directory=%2Ffixture%2Fa";
      const response = await handler(owner, `${server.url}${path}`, {
        method: "POST", body, transferId: reply,
        headers: { Authorization: "Bearer fixture-only", "x-opencode-directory": "/fixture/a", "Content-Type": "application/json" },
      });
      assert.equal(response.status, reply === "reject" ? 409 : 200);
      assert.equal(response.body, "true");
      assert.equal(requests.at(-1).body, body);
      assert.equal(requests.at(-1).method, "POST");
      assert.equal(requests.at(-1).url, path);
      assert.equal(requests.at(-1).headers.authorization, "Bearer fixture-only");
      assert.equal(requests.at(-1).headers["x-opencode-directory"], "/fixture/a");
      assert.equal(registry.cancel(owner, reply), false);
    }
    assert.equal(requests.length, 3);
    assert.equal(owner.sender.listenerCount("destroyed"), 0);
  } finally { await server.close(); }
});

test("main cancellation admission matches only permission reply POSTs and the existing read/archive/Stop allowlist", async () => {
  const signals = [];
  const registry = createDesktopTransferRegistry();
  const handler = await mainFetchHandler(registry, async (_url, init) => {
    signals.push(init.signal);
    return Response.json(true);
  });
  const owner = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
  for (const path of ["/permission/per_1/reply", "/workspace/ws_1/opencode/permission/per_1/reply", "/proxy/w/ws_1/opencode/permission/per_1/reply?directory=x", "/session/ses_1/abort"]) {
    await handler(owner, `http://127.0.0.1${path}`, { method: "post", transferId: "fixture" });
    assert.ok(signals.at(-1) instanceof AbortSignal);
  }
  for (const path of ["/permission", "/permissions/per_1/reply", "/notpermission/per_1/reply", "/permission//reply", "/permission/per%2F1/reply", "/permission/per_1/reply/", "/permission/per_1/reply/extra", "/permission/per_1/reply-other", "/permission/per_1/extra/reply", "/session/ses_1/prompt_async", "/session/ses_1/command", "/question/que_1/reply", "/output?next=/permission/per_1/reply"]) {
    await handler(owner, `http://127.0.0.1${path}`, { method: "POST", transferId: "fixture" });
    assert.equal(signals.at(-1), undefined, path);
  }
  await handler(owner, "http://127.0.0.1/permission/per_1/reply", { method: "DELETE", transferId: "fixture" });
  assert.equal(signals.at(-1), undefined);
});

for (const phase of ["headers", "body"]) {
  test(`main permission cancellation closes the upstream POST during held ${phase} without retry`, { timeout: 5_000 }, async () => {
    let arrived;
    let closed;
    let reading;
    const arrival = new Promise(resolve => { arrived = resolve; });
    const closure = new Promise(resolve => { closed = resolve; });
    const consumption = new Promise(resolve => { reading = resolve; });
    let calls = 0;
    const server = await listen((_request, response) => {
      calls += 1;
      response.once("close", closed);
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("[");
      }
      arrived();
    });
    const registry = createDesktopTransferRegistry();
    const owner = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
    const other = { sender: Object.assign(new EventEmitter(), { id: 2 }) };
    const handler = await mainFetchHandler(registry, async (...args) => {
      const response = await fetchFiniteDesktopHttp(...args);
      reading();
      return response;
    });
    try {
      const pending = handler(owner, `${server.url}/workspace/ws_1/opencode/permission/per_1/reply`, {
        method: "POST", body: '{"reply":"once"}', transferId: "permission",
      });
      const rejected = assert.rejects(pending, { name: "AbortError" });
      await arrival;
      if (phase === "body") await consumption;
      assert.equal(registry.cancel(other, "permission"), false);
      assert.equal(registry.cancel(owner, "permission"), true);
      await rejected;
      await closure;
      assert.equal(calls, 1);
      assert.equal(registry.cancel(owner, "permission"), false);
      assert.equal(owner.sender.listenerCount("destroyed"), 0);
    } finally { registry.cancel(owner, "permission"); await server.close(); }
  });
}

test("remote, lookalike loopback, and HTTPS retain the exact Chromium fetch and its trust policy", async () => {
  for (const method of ["PATCH", "POST"]) for (const url of ["https://127.0.0.1/permission/per_1/reply", "https://localhost/permission/per_1/reply", "https://example.invalid/permission/per_1/reply", "http://127.0.0.1.example.invalid/permission/per_1/reply", "http://localhost.example.invalid/permission/per_1/reply", "http://192.168.1.1/permission/per_1/reply"]) {
    const init = { method, body: '{"reply":"once"}', signal: AbortSignal.timeout(1_000) };
    const expected = new Response("fixture", { status: 418 });
    let calls = 0;
    const response = await fetchFiniteDesktopHttp(url, init, async (receivedUrl, receivedInit) => {
      calls += 1;
      assert.equal(receivedUrl, url);
      assert.equal(receivedInit, init);
      return expected;
    });
    assert.equal(response, expected);
    assert.equal(calls, 1);
  }
});

test("loopback redirects are rejected even when the caller asks to follow", async () => {
  let redirected = 0;
  const target = await listen((_request, response) => { redirected += 1; response.end("must not reach"); });
  const server = await listen((_request, response) => { response.writeHead(302, { location: `${target.url}/secret` }); response.end(); });
  try {
    for (const method of ["PATCH", "POST"]) await assert.rejects(fetchFiniteDesktopHttp(`${server.url}/permission/per_1/reply`, {
      method, body: '{"reply":"always"}', redirect: "follow", headers: { Authorization: "Bearer fixture-only" },
    }, noExternal));
    assert.equal(redirected, 0);
  } finally { await server.close(); await target.close(); }
});

test("cancellation includes held body consumption and preserves the caller reason", async () => {
  let calls = 0;
  const server = await listen((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.write("[");
  });
  const controller = new AbortController();
  const reason = new Error("fixture archive deadline");
  try {
    const response = await fetchFiniteDesktopHttp(server.url, { signal: controller.signal }, noExternal);
    const body = response.text();
    controller.abort(reason);
    await assert.rejects(body, error => error === reason || (error instanceof Error && error.name === "AbortError"));
    assert.equal(controller.signal.reason, reason);
    assert.equal(calls, 1);
    await assert.rejects(fetchFiniteDesktopHttp(server.url, { signal: controller.signal }, noExternal));
    assert.equal(calls, 1);
  } finally { controller.abort(); await server.close(); }
});
