import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeploymentServiceReadiness } from "@openwork/types/den/service-readiness";
import { adminServicesTransport } from "./admin-services-transport";
import { serviceRows } from "./service-readiness-data";

const report: DeploymentServiceReadiness = { version: 2, checkedAt: null, checking: false, server: null, services: serviceRows(null) };

test("the platform admin adapter keeps its paths, sends a bodyless check and reads the version-2 snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => { calls.push({ path: String(input), init: init ?? {} }); return Response.json(report); };
  try {
    const signal = new AbortController().signal;
    assert.equal((await adminServicesTransport.getSnapshot(signal)).access, "ready");
    assert.equal((await adminServicesTransport.startCheck(signal)).access, "ready");
    assert.ok(calls[0].path.endsWith("/v1/admin/services"));
    assert.ok(calls[1].path.endsWith("/v1/admin/services/check"));
    assert.deepEqual(calls.map((call) => call.init.method), ["GET", "POST"]);
    assert.equal(calls[1].init.body, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("old snapshots and leaked fields are rejected instead of rendered", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const signal = new AbortController().signal;
    for (const body of [{ ...report, version: 1 }, { ...report, url: "https://private.example.test" }]) {
      globalThis.fetch = async () => Response.json(body);
      const result = await adminServicesTransport.getSnapshot(signal);
      assert.equal(result.access, "error");
      assert.ok(!JSON.stringify(result).includes("private.example.test"));
    }
    globalThis.fetch = async () => Response.json({ message: "https://private.example.test/secret" }, { status: 429, headers: { "Retry-After": "17" } });
    const limited = await adminServicesTransport.startCheck(signal);
    if (limited.access === "ready") throw new Error("Expected rate limit");
    assert.equal(limited.access, "error");
    assert.equal(limited.retryAfterSeconds, 17);
    assert.equal(limited.status, 429);
  } finally { globalThis.fetch = originalFetch; }
});
