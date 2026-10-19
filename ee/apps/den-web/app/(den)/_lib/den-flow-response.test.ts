import assert from "node:assert/strict";
import { test } from "node:test";
import { requestJson, type DenResponseStatus } from "./den-flow";

for (const status of [401, 403]) {
  test(`an observed ${status} survives a response body transport failure`, async (t) => {
    const observed: DenResponseStatus[] = [];
    const failure = new Error("Response body connection reset");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));
    await assert.rejects(requestJson("/v1/managed-deployments", {}, 0, (response) => observed.push(response)), failure);
    assert.deepEqual(observed, [{ status, ok: false }]);
  });
}

test("a malformed denial body does not hide its HTTP authority", async (t) => {
  const observed: DenResponseStatus[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON", { status: 403 }));
  const read = await requestJson("/v1/managed-deployments", {}, 0, (response) => observed.push(response));
  assert.equal(read.payload, "not JSON");
  assert.deepEqual(observed, [{ status: 403, ok: false }]);
});

test("a transport rejection cannot fabricate an HTTP outcome", async (t) => {
  const observed: DenResponseStatus[] = [];
  const failure = new TypeError("Failed to fetch");
  t.mock.method(globalThis, "fetch", async () => { throw failure; });
  await assert.rejects(requestJson("/v1/managed-deployments", {}, 0, (response) => observed.push(response)), failure);
  assert.deepEqual(observed, []);
});
