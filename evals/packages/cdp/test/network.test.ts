import assert from "node:assert/strict";
import test from "node:test";

import { NETWORK_PROFILES, throttleNetwork, underNetworkConditions } from "../src/network.ts";
import type { Surface } from "../src/surface.ts";

interface SendCall {
  method: string;
  params: Record<string, unknown>;
}

function fakeSurface(): { surface: Surface; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const surface: Surface = {
    handle: { name: "app", kind: "electron", hostKind: "local", cdpUrl: "http://127.0.0.1:9222" },
    client: {
      send: async (method, params = {}) => {
        calls.push({ method, params });
        return {};
      },
      close: () => undefined,
    },
  };
  return { surface, calls };
}

function emulateCalls(calls: SendCall[]): Record<string, unknown>[] {
  return calls.filter((call) => call.method === "Network.emulateNetworkConditions").map((call) => call.params);
}

test("throttling enables the Network domain before emulating conditions", async () => {
  const { surface, calls } = fakeSurface();

  await throttleNetwork(surface, "slow-3g");

  assert.deepEqual(calls.map((call) => call.method), ["Network.enable", "Network.emulateNetworkConditions"]);
  assert.deepEqual(emulateCalls(calls)[0], {
    offline: false,
    latency: NETWORK_PROFILES["slow-3g"].latencyMs,
    downloadThroughput: NETWORK_PROFILES["slow-3g"].downloadBps,
    uploadThroughput: NETWORK_PROFILES["slow-3g"].uploadBps,
  });
});

test("a profile with no throughput ceiling still applies its latency", async () => {
  const { surface, calls } = fakeSurface();

  await throttleNetwork(surface, "high-latency");

  const [applied] = emulateCalls(calls);
  assert.equal(applied.latency, 1500);
  // CDP reads a negative throughput as "do not throttle this direction".
  assert.equal(applied.downloadThroughput, -1);
  assert.equal(applied.uploadThroughput, -1);
});

test("the offline profile takes the surface off the network", async () => {
  const { surface, calls } = fakeSurface();

  await throttleNetwork(surface, "offline");

  assert.equal(emulateCalls(calls)[0].offline, true);
});

test("restoring puts the surface back on an unthrottled network", async () => {
  const { surface, calls } = fakeSurface();

  const throttled = await throttleNetwork(surface, "slow-3g");
  await throttled.restore();

  assert.deepEqual(emulateCalls(calls).at(-1), {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
});

test("disposing the scope restores the network", async () => {
  const { surface, calls } = fakeSurface();

  {
    await using _throttled = await throttleNetwork(surface, "fast-3g");
  }

  assert.equal(emulateCalls(calls).length, 2);
  assert.equal(emulateCalls(calls).at(-1)?.latency, 0);
});

test("a step that throws still restores the network", async () => {
  const { surface, calls } = fakeSurface();

  await assert.rejects(
    underNetworkConditions(surface, "slow-3g", async () => {
      throw new Error("the assertion under bad network failed");
    }),
    /the assertion under bad network failed/,
  );

  assert.equal(emulateCalls(calls).at(-1)?.latency, 0);
});

test("explicit conditions are passed through instead of a named profile", async () => {
  const { surface, calls } = fakeSurface();

  await throttleNetwork(surface, { latencyMs: 250, downloadBps: 1_000, uploadBps: 500 });

  assert.deepEqual(emulateCalls(calls)[0], {
    offline: false,
    latency: 250,
    downloadThroughput: 1_000,
    uploadThroughput: 500,
  });
});
