import assert from "node:assert/strict";
import test from "node:test";
import { postWorkerActivityHeartbeat, readEngineForcePolicy } from "../src/worker-activity-heartbeat.js";

const config = { enabled: true, workerId: "worker", url: "https://den.invalid/heartbeat", token: "secret", intervalMs: 1000, activeWindowMs: 1000 };

test("existing heartbeat payload stays unchanged and explicit false clears forced upgrade", async () => {
  let receivedPolicy: unknown;
  await postWorkerActivityHeartbeat({ config, sessions: [], now: () => 123,
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { sentAt: new Date(123).toISOString(), isActiveRecently: false, lastActivityAt: null, openSessionCount: 0 });
      return Response.json({ ok: true, enginePolicy: { upgrade: false } });
    }, onEnginePolicy: (policy) => { receivedPolicy = policy; },
  });
  assert.deepEqual(receivedPolicy, { upgrade: false });
});

test("legacy responses preserve bootstrap policy", async () => {
  let calls = 0;
  await postWorkerActivityHeartbeat({ config, sessions: [], fetchImpl: async () => new Response(null, { status: 204 }), onEnginePolicy: () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(readEngineForcePolicy({ enginePolicy: {} }), undefined);
  assert.deepEqual(readEngineForcePolicy({ enginePolicy: { upgrade: true } }), { upgrade: true });
});
