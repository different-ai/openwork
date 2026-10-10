import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { Pairing } from "../src/auth/pairing.js";
import { createServers } from "../src/server.js";
import type { OpenWorkAdapter } from "../src/adapters/types.js";

test("an authenticated idle stream survives the ordinary request timeout and closes on revocation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owr-stream-"));
  const store = await Store.open(join(parent, "state"));
  const token = "synthetic-stream-token";
  await store.update((s) => {
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      workspaceIds: ["ws_one"],
      active: true,
      revoked: false,
    });
  });
  const adapter = {
    version: "0.18.57",
    compatibility: "supported",
    capabilities: { events: true },
    listWorkspaces: async () => [],
  } as unknown as OpenWorkAdapter;
  const apps = createServers({
    store,
    pairing: new Pairing(store),
    adapter,
    platform: "linux",
    architecture: "x64",
    origin: "https://host.test:9443",
  });
  const ac = new AbortController();
  try {
    const origin = await apps.remote.listen({ host: "127.0.0.1", port: 0 });
    const headers = { authorization: "Bearer " + token };
    const response = await fetch(origin + "/v1/events", {
      headers,
      signal: ac.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes("event: heartbeat")) {
      const row = await reader.read();
      expect(row.done).toBe(false);
      frames += decoder.decode(row.value);
    }
    expect(frames).toContain("event: reset");
    expect(apps.streams.get("device")?.size).toBe(1);
    const revoke = await fetch(origin + "/v1/device", {
      method: "DELETE",
      headers,
    });
    expect(revoke.status).toBe(204);
    expect((await reader.read()).done).toBe(true);
  } finally {
    ac.abort();
    await apps.remote.close();
    await apps.admin.close();
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 22000);
