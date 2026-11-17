import assert from "node:assert/strict";
import { test } from "node:test";
import { observeDenRequest } from "../src/app/lib/den-request-diagnostics";
import { subscribeClientFailures, type ClientFailureInput } from "../src/app/lib/client-failure-events";

const target = { baseUrl: "https://den.example.test", token: "session", organizationId: "organization" };
test("real Den request observer builds fixed transport classes and signals recovery", async () => {
  const recorded: (ClientFailureInput | null)[] = [];
  const unsubscribe = subscribeClientFailures((failure) => recorded.push(failure));
  try {
    for (const [code, reason] of [["ENOTFOUND", "dns"], ["ERR_CERT_AUTHORITY_INVALID", "certificate"], ["ECONNREFUSED", "connection_refused"], ["ETIMEDOUT", "timeout"], ["ERR_INTERNET_DISCONNECTED", "offline"]]) {
      const error = Object.assign(new Error("private upstream path and hostname"), { code });
      await assert.rejects(observeDenRequest(async () => { throw error; }, target), (caught) => caught === error);
      assert.deepEqual(recorded.pop(), { component: "den_transport", phase: "request", reason });
    }
    await observeDenRequest(async () => ({ ok: false, status: 503 }), target);
    assert.deepEqual(recorded.pop(), { component: "den_transport", phase: "request", reason: "server_error", httpStatus: 503 });
    await assert.rejects(observeDenRequest(async (timeout) => { timeout(); throw new Error("private"); }, target));
    assert.deepEqual(recorded.pop(), { component: "den_transport", phase: "request", reason: "timeout" });
    await observeDenRequest(async () => ({ ok: true, status: 200 }), target);
    assert.equal(recorded.pop(), null);
    await observeDenRequest(async () => ({ ok: false, status: 400 }), target);
    assert.equal(recorded.length, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(observeDenRequest(async () => { throw new DOMException("Cancelled", "AbortError"); }, target, controller.signal));
    assert.equal(recorded.length, 0);
  } finally { unsubscribe(); }
});
test("diagnostic delivery cannot turn a successful user request into failure", async () => {
  const unsubscribe = subscribeClientFailures(() => { throw new Error("delivery failed"); });
  try { assert.deepEqual(await observeDenRequest(async () => ({ ok: true, status: 200 }), target), { ok: true, status: 200 }); }
  finally { unsubscribe(); }
});
