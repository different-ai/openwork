import assert from "node:assert/strict";
import { test } from "node:test";
import { sendAdmin } from "../admin-request";

test("Check now sends no body or browser-controlled probe options, forwards abort, and reads bounded Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(init ?? {});
    return new Response("{}", { status: 429, headers: { "Retry-After": "17" } });
  };
  try {
    const result = await sendAdmin("/v1/admin/services/check", "POST", undefined, controller.signal);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body, undefined);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].signal, controller.signal);
    assert.equal(new Headers(requests[0].headers).get("Content-Type"), null);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected rate limit");
    assert.equal(result.retryAfterSeconds, 17);
    assert.equal(result.status, 429);
    for (const value of ["-1", "0", "Infinity", "9999999999999999", "private upstream failure"]) {
      globalThis.fetch = async () => new Response("{}", { status: 429, headers: { "Retry-After": value } });
      const response = await sendAdmin("/v1/admin/services/check", "POST", undefined, controller.signal);
      if (response.ok) throw new Error("Expected rate limit");
      assert.equal(response.retryAfterSeconds, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
