import assert from "node:assert/strict";
import test from "node:test";

import { desktopFetch } from "./desktop-fetch.mjs";

test("desktop fetch forwards method, headers, body, and response details", async () => {
  const calls = [];
  const result = await desktopFetch("https://worker.example.test/env", {
    method: "POST",
    headers: { Authorization: "Bearer client-token" },
    body: "{}",
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response("ok", {
      status: 202,
      statusText: "Accepted",
      headers: { "x-test": "yes" },
    });
  });

  assert.equal(calls[0].url, "https://worker.example.test/env");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer client-token" });
  assert.equal(calls[0].init.body, "{}");
  assert.equal(result.status, 202);
  assert.equal(result.statusText, "Accepted");
  assert.equal(new Map(result.headers).get("x-test"), "yes");
  assert.equal(result.body, "ok");
});

test("desktop fetch honors timeoutMs with a controlled error", async () => {
  await assert.rejects(
    desktopFetch("https://worker.example.test/slow", { timeoutMs: 1 }, async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
    })),
    /Fetch timed out after 1ms/,
  );
});
