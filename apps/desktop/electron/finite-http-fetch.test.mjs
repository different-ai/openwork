import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fetchFiniteDesktopHttp } from "./finite-http-fetch.mjs";

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

test("remote, lookalike loopback, and HTTPS retain the exact Chromium fetch and its trust policy", async () => {
  for (const url of ["https://127.0.0.1/session", "https://localhost/session", "https://example.invalid/session", "http://127.0.0.1.example.invalid/session", "http://localhost.example.invalid/session", "http://192.168.1.1/session"]) {
    const init = { method: "PATCH", body: "{}", signal: AbortSignal.timeout(1_000) };
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
    await assert.rejects(fetchFiniteDesktopHttp(server.url, { redirect: "follow", headers: { Authorization: "Bearer fixture-only" } }, noExternal));
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
