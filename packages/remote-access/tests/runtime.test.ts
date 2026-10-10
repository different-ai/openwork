import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Store } from "../src/storage/store.js";
import { OpenWorkV2 } from "../src/adapters/openwork-v2-01857.js";

// Keep the initial failure an assertion about the missing lifecycle contract.
const runtime = await import("../src/runtime.js").catch(() => ({}));
const starter = () => {
  expect(runtime).toHaveProperty("startBridge");
  return (runtime as typeof import("../src/runtime.js")).startBridge;
};
function adapter() {
  const api = new OpenWorkV2(async () => {
    throw Error("No live upstream in this test");
  });
  api.version = "0.18.57";
  api.health = async () => {};
  api.listWorkspaces = async () => [];
  return api;
}
async function setup() {
  const parent = await mkdtemp(join(tmpdir(), "owr-embedded-"));
  return {
    parent,
    options: {
      adapter: adapter(),
      stateDirectory: join(parent, "state"),
      platform: "linux" as const,
      architecture: "x64",
      origin: "https://test.tailnet.ts.net:9443",
      remotePort: 0,
    },
  };
}

test("embedded bridge has local controls without an admin HTTP listener; stop is idempotent", async () => {
  const start = starter(),
    { parent, options } = await setup();
  let bridge: Awaited<ReturnType<typeof start>> | undefined;
  try {
    bridge = await start(options);
    expect(bridge.adminAddress).toBeNull();
    const state = await bridge.controls.state();
    expect(state.devices).toEqual([]);
    expect(state).not.toHaveProperty("csrf");
    expect(state).not.toHaveProperty("token");
    expect((await fetch(bridge.address + "/admin/state")).status).toBe(404);
    expect((await fetch(bridge.address + "/v1/workspaces")).status).toBe(401);
    await Promise.all([bridge.stop(), bridge.stop()]);
    await expect(
      readFile(join(options.stateDirectory, "lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(bridge.controls.pair()).rejects.toThrow("BRIDGE_STOPPED");
  } finally {
    await bridge?.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("embedded handover preserves host identity, active credentials, project scope, and ledger", async () => {
  const start = starter(),
    { parent, options } = await setup();
  const store = await Store.open(options.stateDirectory);
  await store.update((s) => {
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update("synthetic-token").digest("hex"),
      workspaceIds: ["ws_one"],
      allWorkspaces: false,
      active: true,
      revoked: false,
    });
    s.ledger["synthetic"] = {
      deviceId: "device",
      hash: "a".repeat(64),
      route: "/test",
      createdAt: "2026-10-08T00:00:00Z",
      receipt: {
        requestId: "synthetic",
        resourceId: null,
        state: "confirmed",
        observedAt: "2026-10-08T00:00:00Z",
      },
    };
  });
  const before = store.snapshot;
  await store.close();
  let bridge: Awaited<ReturnType<typeof start>> | undefined;
  try {
    bridge = await start(options);
    const state = await bridge.controls.state();
    expect(state.host.hostId).toBe(before.hostId);
    expect(state.devices[0]).not.toHaveProperty("tokenHash");
    await bridge.stop();
    expect(
      JSON.parse(
        await readFile(join(options.stateDirectory, "state.json"), "utf8"),
      ),
    ).toEqual(before);
    bridge = await start(options);
    expect((await bridge.controls.state()).devices[0]?.allWorkspaces).toBe(
      false,
    );
  } finally {
    await bridge?.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a occupied listener and failed event startup release the state lock and all acquired listeners", async () => {
  const start = starter(),
    { parent, options } = await setup();
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string")
    throw Error("Expected local listener");
  try {
    await expect(
      start({ ...options, remotePort: address.port }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(
      readFile(join(options.stateDirectory, "lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    options.adapter.listWorkspaces = async () => {
      throw Error("EVENT_START_FAILED");
    };
    await expect(start(options)).rejects.toThrow("EVENT_START_FAILED");
    const reopened = await Store.open(options.stateDirectory);
    await reopened.close();
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(parent, { recursive: true, force: true });
  }
});

test("local control access edits validate project IDs and revoke immediately", async () => {
  const start = starter(),
    { parent, options } = await setup();
  const store = await Store.open(options.stateDirectory);
  await store.update((s) =>
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update("synthetic-token").digest("hex"),
      workspaceIds: [],
      active: true,
      revoked: false,
    }),
  );
  await store.close();
  let bridge: Awaited<ReturnType<typeof start>> | undefined;
  try {
    bridge = await start(options);
    await expect(
      bridge.controls.access("device", {
        workspaceIds: ["unknown"],
        allWorkspaces: false,
      }),
    ).rejects.toThrow("INVALID_REQUEST");
    await bridge.controls.access("device", {
      workspaceIds: [],
      allWorkspaces: true,
    });
    expect((await bridge.controls.state()).devices[0]?.allWorkspaces).toBe(
      true,
    );
    await bridge.controls.revoke("device");
    expect((await bridge.controls.state()).devices).toEqual([]);
    expect(
      (
        await fetch(bridge.address + "/v1/workspaces", {
          headers: { authorization: "Bearer synthetic-token" },
        })
      ).status,
    ).toBe(401);
  } finally {
    await bridge?.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test.each([
  ["0.0.0-dev", "0.0.0-dev", true, "supported"],
  ["0.0.0-dev", "0.0.0-dev", false, "supported"],
  ["0.0.0-dev", undefined, true, "incompatible"],
  ["0.18.57", undefined, false, "supported"],
] as const)(
  "host handshake agrees with adapter compatibility (%s, %s, writes %s)",
  async (version, bundledVersion, writes, compatibility) => {
    const { parent, options } = await setup();
    const api = new OpenWorkV2(
      async () => {
        throw Error("No upstream");
      },
      writes,
      bundledVersion,
    );
    api.version = version;
    api.health = async () => {};
    api.listWorkspaces = async () => [];
    const bridge = await starter()({ ...options, adapter: api });
    try {
      expect((await bridge.controls.state()).host).toMatchObject({
        upstreamVersion: version,
        compatibility,
      });
    } finally {
      await bridge.stop();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
